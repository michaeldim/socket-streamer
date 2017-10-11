import https from 'https'
import commander from 'commander'
import autobahn from 'autobahn'
import WebSocket from 'ws'
import Redis from 'redis'
import Promise from 'bluebird'
import _ from 'lodash'

Promise.promisifyAll(Redis.RedisClient.prototype)
Promise.promisifyAll(Redis.Multi.prototype)

commander
    .version('1.0.0')
    .option('-r, --redis <redisUrl>', 'Redis URL [redis://localhost:6379]')
    .option('-w, --ws <wsUrl>', 'WebSocket URL [wss://api2.poloniex.com]')
    .option('-p, --prefix <redisPrefix>', 'Redis Prefix [orderbook]')
    .option('-t, --trade <tradeChannel>', 'Trade info Redis channel [poloniex_trade]')
    .option('-v, --version <apiVersion>', 'Poloniex API Version [2]')
    .parse(process.argv)

let redisUrl = commander.redis ? commander.redis : 'redis://localhost:6379'
let wsUrl = commander.ws ? commander.ws : 'wss://api2.poloniex.com'
let redisPrefix = commander.redisPrefix ? commander.redisPrefix : 'orderbook'
let tradeChannel = commander.tradeChannel ? commander.tradeChannel : 'poloniex_trade'
let apiVersion = commander.apiVersion ? commander.apiVersion : 2 // could be 1 or 2

// parameter
const RECONNECT_INTERVAL = 60000 // 1 min
const ERROR_RECONNECT_INTERVAL = 600000 // 10 min
const OP_QUEUE_LIMIT = 1024
const TICK_DEPTH = 128

const markets = [
    'BTC_ZEC',
    'BTC_ETH',
    'ETH_ZEC'
]

// const socket = new autobahn.Connection({url: wampUrl, realm: 'realm1'})
const client = Redis.createClient(redisUrl)

let watchDog = null

let printLog = msg => {
    let now = new Date()
    console.log(now.toLocaleString(), msg)
    // console.trace()
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
                // console.log(buffer)
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
        .catch(err => {
            printLog(err)
        })
}

let readOrderbook = (market, limit) => {
    // WARNING : current implementation does NOT support multiple redis clients
    // limit = -1 to get full depth
    let askPromise = client.zrangeAsync(getOrderbookKey(market, 'asks.sset'), 0, limit)
        .then(asks => {
            if (asks === undefined || asks == null || asks.length == 0)
                return Promise.resolve([])

            return client.hmgetAsync(getOrderbookKey(market, 'asks.hash'), asks)
                .then(askQs => {
                    /*
                    let askPairs = askQs.map((q, index) => {
                        if (q === undefined || q == null)
                            return null
                        else {
                            let pair = [asks[index], q]
                            // pair[asks[index]] = q
                            return pair
                        }
                    })
                    .filter(curr => {
                        if (curr == null)
                            return false
                        else
                            return true
                    })
                    */

                    let askPairs = [asks, askQs]

                    return Promise.resolve(askPairs)
                })
        })

    let bidPromise = client.zrevrangeAsync(getOrderbookKey(market, 'bids.sset'), 0, limit)
        .then(bids => {
            if (bids === undefined || bids == null || bids.length == 0)
                return Promise.resolve([])
            
            return client.hmgetAsync(getOrderbookKey(market, 'bids.hash'), bids)
                .then(bidQs => {
                    /*
                    let bidPairs = bidQs.map((q, index) => {
                        if (q === undefined || q == null)
                            return null
                        else {
                            let pair = [bids[index], q]
                            // pair[bids[index]] = q
                            return pair
                        }
                    })
                    .filter(curr => {
                        if (curr == null)
                            return false
                        else
                            return true
                    })
                    */

                    let bidPairs = [bids, bidQs]

                    return Promise.resolve(bidPairs)
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
            context.orderbook['frozen'] = parseInt(frozen)
            return client.getAsync(getOrderbookKey(market, 'seq'))
        })
        .then(seq => {
            context.orderbook['seq'] = parseInt(seq)
            return Promise.resolve(context.orderbook)
        })
}

let messageHandler = (market, msg) => {
    // check orderbook seq
    client.getAsync(getOrderbookKey(market, 'seq'))
    .then(seq => {
        if (seq !== undefined && seq != null) {
            seq = parseInt(seq)
            if (seq + 1 == msg.seq) {
                // console.log('exec', 'market.seq', seq, 'msg.seq', msg.seq)

                // exec current msg
                let commands = client.multi()

                msg.ops.map(op => {
                    updateOrderbook(market, op, commands)
                })

                commands.incr(getOrderbookKey(market, 'seq'))

                commands.execAsync()
                    .then(replies => {
                        sendTick(market)

                        // execute stored msg in order
                        execStoredMsgs(market)
                    })
                    .catch(err => {
                        printLog(err)
                    })
            }
            else if (seq + 1 < msg.seq) {
                // store msg in order
                storeMsg(market, msg)
                    .then(() => {
                        execStoredMsgs(market)
                    })
            }
            else {
                // expired msg, drop and exec stored msg in order
                execStoredMsgs(market)
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
    // console.log('storeMsg', 'msg.seq', msg.seq)

    return client.zaddAsync(getOrderbookKey(market, 'ops'), msg.seq, JSON.stringify(msg))
    .then(() => {
        return client.zcardAsync(getOrderbookKey(market, 'ops'))
    })
    .then(count => {
        count = parseInt(count)
        if (count > OP_QUEUE_LIMIT) {
            // consider we have lost op(s), discard op queue and refresh orderbook
            client.del(getOrderbookKey(market, 'ops'))

            // TODO : refresh with restful API
            getOrderbook(market)
                .then(orderbook => {
                    refreshOrderbook(market, orderbook)
                })
        }
    })
}

let execStoredMsgs = market => {
    let context = {}

    client.getAsync(getOrderbookKey(market, 'seq'))
        .then(seq => {
            context['seq'] = parseInt(seq)
            return client.zrangeAsync(getOrderbookKey(market, 'ops'), 0, -1)
        })
        .then(storedMsgs => {
            storedMsgs = storedMsgs.map(JSON.parse)

            if (storedMsgs != null && storedMsgs.length != 0) {
                let commands = client.multi()
                let commandFlag = false

                storedMsgs.map(storedMsg => {
                    if (context.seq + 1 == storedMsg.seq) {
                        // console.log('execStoredMsgs:exec', 'market.seq', context.seq, 'msg.seq', storedMsg.seq)

                        // exec next msg
                        commandFlag = true

                        storedMsg.ops.map(op => {
                            updateOrderbook(market, op, commands)
                        })

                        commands.zrem(getOrderbookKey(market, 'ops'), JSON.stringify(storedMsg))
                        commands.incr(getOrderbookKey(market, 'seq'))

                        context.seq++

                        sendTick(market)
                    }
                    else if (context.seq + 1 > storedMsg.seq) {
                        // console.log('execStoredMsgs:remove', 'market.seq', context.seq, 'msg.seq', storedMsg.seq)
                        // remove outdated msg
                        commands.zrem(getOrderbookKey(market, 'ops'), JSON.stringify(storedMsg))
                    }
                })

                if (commandFlag)
                    commands.exec()
                else
                    commands.discard()
            }
        })
}

let sendTick = market => {
    readOrderbook(market, TICK_DEPTH)
        .then(orderbook => {
            client.publish(market, JSON.stringify(orderbook))
        })
}

let orderbookWrapper = (rawOp, seq) => {
    let orderbook = null

    try {
        orderbook = rawOp[1].orderBook
        let asks = _.toPairs(orderbook[0])
        let bids = _.toPairs(orderbook[1])
        orderbook = {asks: asks, bids: bids, isFrozen: 0, seq: parseInt(seq)}
    }
    catch(err) {
        printLog(err)
    }
    finally {
        return orderbook
    }
}

let opWrapper = (rawOp) => {
    let arg = null

    try {
        arg = {type: 'orderBookModify'}
        
        if (rawOp[3] == '0.00000000') {
            arg.type = 'orderBookRemove'
            arg['data'] = {rate: rawOp[2]}
        }
        else {
            arg['data'] = {rate: rawOp[2], amount: rawOp[3]}
        }
    
        if (rawOp[1] == 0)
            arg.data['type'] = 'ask'
        else
            arg.data['type'] = 'bid'
    }
    catch(err) {
        printLog(err)
    }
    finally {
        return arg
    }
}

markets.map(market => {
    if (apiVersion == 1) {
        // WAMP protocol
        let socket = new autobahn.Connection({url: wsUrl, realm: 'realm1'})
        
        let marketHandler = (args, kwargs) => {
            // [{data: {rate: '0.00300888', type: 'bid', amount: '3.32349029'},type: 'orderBookModify'}]
            // [{data: {rate: '0.00311164', type: 'ask' },type: 'orderBookRemove'}]

            // console.log('args', args, 'kwargs', kwargs)
    
            let msg = {ops: args, seq: kwargs['seq']}
            messageHandler(market, msg)
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

        ws.on('open', () => {
            printLog('WebSocket connected to ' + wsUrl)
            ws.send(JSON.stringify({command: 'subscribe', channel: market}))
            printLog('Subscribing to ' + market)
        })

        ws.on('message', message => {
            // [178,91878377,[["o",1,"0.05013632","0.00000000"],["o",1,"0.05011473","178.09400000"]]]

            try {
                message = JSON.parse(message)

                let opCode = message[0]
                let seq = message[1]
                let rawOps = message[2]
    
                switch(opCode) {
                    case 1001:
                    // trollbox event
                    break
    
                    case 1002:
                    // tick event
                    break
    
                    case 1010:
                    // heartbeat
                    break
    
                    default:
                    if (opCode > 0 && opCode < 1000) {
                        // orderbook event

                        let ops = rawOps.map(rawOp => {
                            switch (rawOp[0]) {
                                case 'i':
                                // init market orderbook
                                try {
                                    let orderbook = orderbookWrapper(rawOp, seq)
                                    if (orderbook != null)
                                        refreshOrderbook(market, orderbook)
                                }
                                catch(err) {
                                    printLog(err)
                                }
                                finally {
                                    return null
                                }
                                break
                                
                                case 'o':
                                // convert to api version1 op
                                let arg = opWrapper(rawOp)
                                if (arg != null)
                                    return arg
                                break
            
                                case 't':
                                // trade
                                let trade = {
                                    tradeID: rawOp[1],
                                    type: (rawOp[2] == 1 ? 'buy' : 'sell'),
                                    rate: rawOp[3],
                                    amount: rawOp[4],
                                    total: parseFloat(rawOp[3]) * parseFloat(rawOp[4]),
                                    ts: rawOp[5],
                                    market: market
                                }
                                client.publish(tradeChannel, JSON.stringify(trade))
                                return null
                                break
            
                                default:
                                printLog('Unknown message type')
                                return null
                                break
                            }
                        })
                        .filter(curr => {
                            if (curr == null)
                                return false
                            else
                                return true
                        })
            
                        if (ops.length !== 0) {
                            let msg = {ops: ops, seq: seq}
                            messageHandler(market, msg)
                        }
                    } // if 0 < opCode < 1000
                    break // default
                }
            }
            catch(err) {
                printLog(err)
                return
            }
        }) // ws on message

        ws.on('disconnect', () => {
            printLog('Websocket disconnected from ' + wsUrl)
        })
    }
    else {
        printLog('Unknown Websocket Protocol')
    }
})

setInterval(() => {
    markets.map(market => {
        readOrderbook(market, 10)
            .then(orderbook => {
                console.log(JSON.stringify(orderbook))
            })
    })
}, 10000)