import https from 'https'
import commander from 'commander'
import autobahn from 'autobahn'
import WebSocket from 'ws'
import Redis from 'redis'
import Promise from 'bluebird'

Promise.promisifyAll(Redis.RedisClient.prototype)
Promise.promisifyAll(Redis.Multi.prototype)

commander
    .version('1.0.0')
    .option('-r, --redis <redisUrl>', 'Redis URL')
    .option('-w, --ws <wsUrl>', 'WebSocket URL')
    .option('-p, --prefix <redisPrefix>', 'Redis Prefix')
    .option('-v, --version <apiVersion>', 'Poloniex API Version')
    .parse(process.argv)

let redisUrl = commander.redis ? commander.redis : 'redis://localhost:6379'
let wsUrl = commander.ws ? commander.ws : 'wss://api2.poloniex.com'
let redisPrefix = commander.redisPrefix ? commander.redisPrefix : 'orderbook'
let apiVersion = commander.apiVersion ? commander.apiVersion : 2 // may be 1 or 2

// parameter
const RECONNECT_INTERVAL = 60000 // 1 min
const ERROR_RECONNECT_INTERVAL = 600000 // 10 min
const OP_QUEUE_LIMIT = 16

const markets = [
    'BTC_ZEC'
]

// const socket = new autobahn.Connection({url: wampUrl, realm: 'realm1'})
const client = Redis.createClient(redisUrl)

let watchDog = null

let printLog = msg => {
    let now = new Date()
    console.log(now.toLocaleString(), msg)
}

let getOrderbookKey = (market, name) => {
    return redisPrefix + ':' + market + ':' + name
}

let getOrderbook = market => {
    return new Promise((resolve, reject) => {
        let prefix = 'https://poloniex.com/public?command=returnOrderBook&currencyPair='
        https.get(prefix + market, res => {
            let buffer = ''

            res.on('data', data => {
                buffer += data
            })

            res.on('end', () => {
                console.log(buffer)
                try {
                    let json = JSON.parse(buffer)
                    resolve(json)
                }
                catch (err) {
                    reject(err)
                }
            })

        })
        .on('error', err => {
            reject(err)
        })
    })
}

let refreshOrderbook = (market, orderbook) => {
    // store new orderbook in redis
    let asks = orderbook.asks
    let bids = orderbook.bids

    let commands = client.multi()
        .del(getOrderbookKey(market, 'asks.sset'))
        .del(getOrderbookKey(market, 'asks.hash'))
        .del(getOrderbookKey(market, "bids.sset"))
        .del(getOrderbookKey(market, 'bids.hash'))
        .set(getOrderbookKey(market, 'frozen'), orderbook['isFrozen'])
        .set(getOrderbookKey(market, 'seq'), orderbook['seq'])

    asks.map(ask => {
        commands.zadd(getOrderbookKey(market, 'asks.sset'), parseFloat(ask[0]), ask[0])
        commands.hset(getOrderbookKey(market, 'asks.hash'), ask[0], ask[1])
    })

    bids.map(bid => {
        commands.zadd(getOrderbookKey(market, "bids.sset"), parseFloat(bid[0]), bid[0])
        commands.hset(getOrderbookKey(market, 'bids.hash'), bid[0], bid[1])
    })

    return commands.execAsync()
        .then((err, replies) => {
            if (err) {
                printLog(err.errors)
            }
        })
}

let readOrderbook = market => {
    // WARNING : current implementation does NOT support multiple redis clients

    let askPromise = client.zrangeAsync(getOrderbookKey(market, 'asks.sset'), 0, -1)
        .then(asks => {
            if (asks === undefined || asks == null || asks.length == 0)
                return Promise.resolve([])

            return client.hmgetAsync(getOrderbookKey(market, 'asks.hash'), asks)
                .then(askPairs => {
                    let filteredAskPairs = askPairs.filter(ask => {
                        if (ask === undefined || ask == null)
                            return false
                        else
                            return true
                    })

                    return Promise.resolve(filteredAskPairs)
                })
        })

    let bidPromise = client.zrevrangeAsync(getOrderbookKey(market, 'bids.sset'), 0, -1)
        .then(bids => {
            if (bids === undefined || bids == null || bids.length == 0)
                return Promise.resolve([])
            
            return client.hmgetAsync(getOrderbookKey(market, 'bids.hash'), bids)
                .then(bidPairs => {
                    let filteredBidPairs = bidPairs.filter(bid => {
                        if (bid === undefined || bid == null)
                            return false
                        else
                            return true
                    })

                    return Promise.resolve(filteredBidPairs)
                })
        })

    let context = {}
    return Promise.all([askPromise, bidPromise])
        .then(orders => {
            let orderbook = {market: market, asks: orders[0], bids: orders[1]}
            return Promise.resolve(orderbook)
        })
        .then(orderbook => {
            context['orderbook'] = orderbook
            return client.getAsync(getOrderbookKey(market, 'frozen'))
        })
        .then(frozen => {
            context.orderbook['frozen'] = frozen
            return client.getAsync(getOrderbookKey(market, 'seq'))
        })
        .then(seq => {
            context.orderbook['seq'] = seq
            return Promise.resolve(context.orderbook)
        })
}

let updateOrderbook = (market, op, commands) => {
    switch(op.type) {
        case 'orderBookModify':
        commands.zadd(getOrderbookKey(market, op.data['type'] + 's.sset'), parseFloat(op.data['rate']), op.data['rate'])
        commands.hset(getOrderbookKey(market, op.data['type'] + 's.hash'), op.data['rate'], op.data['amount'])
        break

        case 'orderBookRemove':
        commands.zrem(getOrderbookKey(market, op.data['type'] + 's.sset'), op.data['rate'])
        commands.hdel(getOrderbookKey(market, op.data['type'] + 's.hash'), op.data['rate'])
        break

        default:
        // do nothing
        break
    }

    return commands
}

let storeMsg = (market, msg) => {
    client.zaddAsync(getOrderbookKey(market, 'ops'), msg.seq, JSON.stringify(msg))
    .then(() => {
        return client.zcardAsync(getOrderbookKey(market, 'ops'))
    })
    .then(count => {
        if (count > OP_QUEUE_LIMIT) {
            // consider we have lost op(s), discard op queue and refresh orderbook
            client.del(getOrderbookKey(market, 'ops'))
            refreshOrderbook(market)
        }
    })
}

let execStoredMsgs = market => {
    client.getAsync(getOrderbookKey(market, 'seq'))
        .then(seq => {
            return client.zrangeAsync(getOrderbookKey(market, 'ops'), 0, -1).bind({seq: seq})
        })
        .then(storedMsgs => {
            storedMsgs = JSON.parse(storedMsgs)

            if (storedMsgs != null && storedMsgs.length != 0) {
                let commands = client.multi()
                let commandFlag = false

                for (storedMsg in storedMsgs) {
                    if (this.seq + 1 == storedMsg.seq) {
                        commandFlag = true

                        for (op in storeMsg.ops)
                            commands = updateOrderbook(market, op, commands)

                        commands.zrem(getOrderbookKey(market, 'ops'), JSON.stringify(storedMsg))
                        commands.incr(getOrderbookKey(market, 'seq'))

                        this.seq++
                    }
                    else if (this.seq + 1 > storedMsg.seq) {
                        // remove outdated msg
                        commands.zrem(getOrderbookKey(market, 'ops'), JSON.stringify(storedMsg))
                    }
                    else if (this.seq + 1 < storeMsg.seq) {
                        // too far away, exit and wait
                        break
                    }
                }

                if (commandFlag)
                    commands.exec()
                else
                    commands.discard()
            }
        })
}

markets.map(market => {
    if (apiVersion == 1) {
        // WAMP protocol
        let socket = new autobahn.Connection({url: wsUrl, realm: 'realm1'})
        
        let marketHandler = (args, kwargs) => {
            // console.log('args', args, 'kwargs', kwargs)
    
            let msg = {ops: args, seq: kwargs['seq']}
    
            // check orderbook seq
            client.getAsync(getOrderbookKey(market, 'seq'))
                .then(seq => {
                    if (seq !== undefined && seq != null) {
                        if (seq + 1 == msg.seq) {
                            // exec current msg
                            let commands = client.multi()
    
                            for (op in msg.ops) {
                                commands = updateOrderbook(market, op, commands)
                            }
    
                            commands.incr(getOrderbookKey(market, 'seq'))
    
                            commands.execAsync()
                                .then((err, replies) => {
                                    if (err) {
                                        printLog(err.errors)
                                    }
    
                                    // execute stored msg in order
                                    execStoredMsgs(market)
                                })
                        }
                        else if (seq + 1 < msg.seq) {
                            // store msg in order
                            storeMsg(market, msg)
                        }
                    }
                    else {
                        // orderbook not ready yet, just store msg in order
                        storeMsg(market, msg)
                    }
                })
                .catch(err => {
                    printLog(err)
                })
        }
        
        socket.onopen = connection => {
            printLog('WAMP connected to ' + wsUrl)
    
            connection.subscribe(market, marketHandler)
            printLog('Subscribing to ' + market)

            getOrderbook(market)
                .then(orderbooks => {
                    refreshOrderbook(market, orderbooks[market])
                })
        }
        
        socket.onclose = () => {
            printLog('WAMP disconnected from ' + wsUrl)
            socket.open()
        }
        
        socket.open()
    }
    else if (apiVersion == 2) {
        // TODO : plain websocket
        let ws = new WebSocket(wsUrl)

        let marketHandler = (args, kwargs)
        ws.on('open', () => {
            printLog('WebSocket connected to ' + wsUrl)
            ws.send(JSON.stringify({command: 'subscribe', channel: market}))
            printLog('Subscribing to ' + market)
        })

        ws.on('message', message => {
            let seq = message[1]
            for (op in message[3]) {
                switch (op[0]) {
                    case 'i':
                    
                    break
                    
                    case 'o':
                    break

                    case 't':
                    break

                    default:
                    printLog('Unknown message type')
                    break
                }
            }
            let msg = convertWsMessage(message)

        })

        ws.on('disconnect', () => {
            
        })
    }
    else {
        printLog('Unknown Websocket Protocol')
    }
})

setInterval(() => {
    /*
    readOrderbook(markets[0])
        .then(orderbook => {
            console.log(JSON.stringify(orderbook))
        })
    */
    getOrderbook(markets[0])
        .then(orderbooks => {
            // console.log(orderbooks)
        })
        .catch(err => {
            console.log(err)
        })
}, 10000)