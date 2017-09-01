import https from 'https'
import commander from 'commander'
import io from 'socket.io-client'
import Redis from 'redis'

let markets = [
    'BTC38',
    'BTCC',
    'BTCE',
    'BTER',
    'Bit2C',
    'Bitfinex',
    'Bitstamp',
    'Bittrex',
    'CCEDK',
    'Cexio',
    'Coinbase',
    'Coinfloor',
    'Coinse',
    'Coinsetter',
    'Cryptopia',
    'Cryptsy',
    'Gatecoin',
    'Gemini',
    'HitBTC',
    'Huobi',
    'itBit',
    'Kraken',
    'LakeBTC',
    'LocalBitcoins',
    'MonetaGo',
    'OKCoin',
    'Poloniex',
    'Yacuna',
    'Yunbi',
    'Yobit',
    'Korbit',
    'BitBay',
    'BTCMarkets',
    'QuadrigaCX',
    'CoinCheck',
    'BitSquare',
    'Vaultoro',
    'MercadoBitcoin',
    'Unocoin',
    'Bitso',
    'BTCXIndia',
    'Paymium',
    'TheRockTrading',
    'bitFlyer',
    'Quoine',
    'Luno',
    'EtherDelta',
    'Liqui',
    'bitFlyerFX',
    'BitMarket',
    'LiveCoin',
    'Coinone',
    'Tidex',
    'Bleutrade',
    'EthexIndia' 
]

let money = [
    'USD',
    'JPY',
    'CNY',
    'EUR',
    'GBP',
    'KRW',
    'HKD',
    'CAD',
    'PLN',
    'ZAR',
    'RUB',
    'AUD',
    'MXN',
    'SGD',
    'RUR',
    'UAH'
]

let currencies = [
    'BTC',
    'LTC',
    'ETH',
    'ETC',
    'ZEC',
    'XRP',
    'XMR',
    'PASC',
    'NMC',
    'EMC2',
    'DOGE',
    'DGB',
    'DASH',
    'BTS',
    'USDT',
    'BCH',
    'STR'
]

let trades = []

commander
    .version('1.0.0')
    .option('-r, --redis <redisUrl>', 'Redis URL')
    .option('-i, --io <ioUrl>', 'Socket.IO URL')
    .option('-c, --channel <pubChannel>', 'Redis Publish Channel')
    .parse(process.argv)

let redisUrl = commander.redis ? commander.redis : 'redis://localhost:6379'
let ioUrl = commander.io ? commander.io : 'http://localhost'
let pubChannel = commander.channel ? commander.channel : 'socket-cc'

const RECONNECT_INTERVAL = 60000 // 1 min
const ERROR_RECONNECT_INTERVAL = 600000 // 10 min

const socket = io(ioUrl, {autoConnect: false})
const pubClient = Redis.createClient(redisUrl)
let watchDog = null

// helper
let getSubsQuery = (fsym, tsym) => {
    return 'https://min-api.cryptocompare.com/data/subs?fsym=' + fsym + '&tsyms=' + tsym
}

let parseMessage = message => {
    let json = null
    try {
        let items = message.split('~')
        if (items[0] == 0) {
            let type = ''
            switch(parseInt(items[0])) {
                case 0:
                type = 'trade'
                break

                case 2:
                type = 'current'
                break

                case 4:
                type = 'currentagg'
                break

                default:
                type = 'unknown'
                break
            }

            let operation = ''
            switch(parseInt(items[4])) {
                case 1:
                operation = 'buy'
                break
                
                case 2:
                operation = 'sell'
                break

                case 4:
                operation = 'unknown'

                default:
                operation = 'unknown'
            }

            json = {
                type: type,
                market: items[1],
                currency1: items[2],
                currency2: items[3],
                operation: operation,
                tradeId: parseInt(items[5]),
                ts: parseInt(items[6]),
                quantity: parseFloat(items[7]),
                price: parseFloat(items[8])
            }
        }
    }
    catch (e) {
        console.log(e.message)
    }
    finally {
        return json
    }
}

socket.on('connect', () => {
    let now = new Date()
    console.log(now.toLocaleString(), 'Socket.IO connected to ' + ioUrl)

    if (watchDog != null) {
        clearInterval(watchDog)
        watchDog = null
    }

    currencies.map(c => {
        currencies.map(c1 => {
            if (c != c1) {
                https.get(getSubsQuery(c, c1), res => {
                    let buffer = ''
                    
                    res.on('data', data => {
                        buffer += data
                    })

                    res.on('end', () => {
                        try {
                            let json = JSON.parse(buffer)
                            if (json !== undefined && json[c1] !== undefined) {
                                let subs = json[c1].TRADES
                                subs.map(sub => {
                                    let same = trades.filter(trade => {
                                        if (sub == trade) {
                                            return true
                                        }
                                        return false
                                    })

                                    if (same.length != 0)
                                        console.log('dup', sub)
                                    else {
                                        socket.emit('SubAdd', {subs: [sub]})
                                        // trades.push(sub)
                                        // console.log('c->c', sub)
                                    }
                                })
                            }
                        }
                        catch (e) {
                            console.log('currency', c, 'currency1', c1, e.message)
                        }
                    })
                })
                .on('error', err => {
                    let now = new Date()
                    console.log(now.toLocaleString(), 'HTTPS.get() Error', err)
                })
            }
        })
    })

    money.map(m => {
        currencies.map(c => {
            https.get(getSubsQuery(m, c), res => {
                let buffer = ''
                
                res.on('data', data => {
                    buffer += data
                })

                res.on('end', () => {
                    try {
                        let json = JSON.parse(buffer)
                        if (json !== undefined && json[c] !== undefined) {
                            let subs = json[c].TRADES
                            subs.map(sub => {
                                let same = trades.filter(trade => {
                                    if (sub == trade) {
                                        return true
                                    }
                                    return false
                                })

                                if (same.length != 0)
                                    console.log('dup', sub)
                                else {
                                    socket.emit('SubAdd', {subs: [sub]})
                                    // trades.push(sub)
                                    // console.log('m->c', sub)
                                }
                            })
                        }
                    }
                    catch (e) {
                        console.log('money', m, 'currency', c, e.message)
                    }
                })
            })
            .on('error', err => {
                let now = new Date()
                console.log(now.toLocaleString(), 'HTTPS.get() Error', err)
            })

            https.get(getSubsQuery(c, m), res => {
                let buffer = ''
                
                res.on('data', data => {
                    buffer += data
                })

                res.on('end', () => {
                    try {
                        let json = JSON.parse(buffer)
                        if (json !== undefined && json[m] !== undefined) {
                            let subs = json[m].TRADES
                            subs.map(sub => {
                                let same = trades.filter(trade => {
                                    if (sub == trade) {
                                        return true
                                    }
                                    return false
                                })

                                if (same.length != 0)
                                    console.log('dup', sub)
                                else {
                                    socket.emit('SubAdd', {subs: [sub]})
                                    // trades.push(sub)
                                    // console.log('c->m', sub)
                                }
                            })
                        }
                    }
                    catch (e) {
                        console.log('currency', c, 'money', m, e.message)
                    }
                })
            })
            .on('error', err => {
                let now = new Date()
                console.log(now.toLocaleString(), 'HTTPS.get() Error', err)
            })
        })

        money.map(m1 => {
            if (m !== m1) {
                https.get(getSubsQuery(m, m1), res => {
                    let buffer = ''
                    
                    res.on('data', data => {
                        buffer += data
                    })

                    res.on('end', () => {
                        try {
                            let json = JSON.parse(buffer)
                            if (json !== undefined && json[m1] !== undefined) {
                                let subs = json[m1].TRADES
                                subs.map(sub => {
                                    let same = trades.filter(trade => {
                                        if (sub == trade) {
                                            return true
                                        }
                                        return false
                                    })

                                    if (same.length != 0)
                                        console.log('dup', sub)
                                    else {
                                        socket.emit('SubAdd', {subs: [sub]})
                                        // trades.push(sub)
                                        // console.log('m->m', sub)
                                    }
                                })
                            }
                        }
                        catch (e) {
                            console.log('money', m, 'money1', m1, e.message)
                        }
                    })
                })
                .on('error', err => {
                    let now = new Date()
                    console.log(now.toLocaleString(), 'HTTPS.get() Error', err)
                })
            } 
        })
    })

})

socket.on('disconnect', () => {
    let now = new Date()
    console.log(now.toLocaleString(), 'Socket.IO disconnected from ' + ioUrl)

    watchDog = setInterval(() => {
        let nowTs = new Date()
        console.log(nowTs.toLocaleString(), 'Reconnecting...')
        socket.close()
        socket.open()
    }, RECONNECT_INTERVAL)
})

socket.on('error', (err) => {
    let now = new Date()
    console.log(now.toLocaleString(), "Error", JSON.stringify(err))

    if (watchDog != null) {
        clearInterval(watchDog)
        watchDog = setInterval(() => {
            let nowTs = new Date()
            console.log(nowTs.toLocaleString(), 'Reconnecting...')
            socket.close()
            socket.open()
        }, ERROR_RECONNECT_INTERVAL)
    }
})

socket.on('m', message => {
    try {
        // console.log(message)
        let json = parseMessage(message)
        if (json != null)
            pubClient.publish(pubChannel, JSON.stringify(json))
    }
    catch (e) {
        console.log(e.message)
    }
})

socket.open()

// https://www.cryptocompare.com/api/data/coinlist/