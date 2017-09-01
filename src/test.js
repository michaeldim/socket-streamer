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
    .option('-i, --io <ioUrl>', 'Socket.IO URL')
    .parse(process.argv)

let ioUrl = commander.io ? commander.io : 'wss://streamer.cryptocompare.com'

// helper
let getSubsQuery = (fsym, tsym) => {
    return 'https://min-api.cryptocompare.com/data/subs?fsym=' + fsym + '&tsyms=' + tsym
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
                                    trades.push(sub)
                                    console.log('c->c', sub)
                                }
                            })
                        }
                    }
                    catch (e) {
                        console.log('currency', c, 'currency1', c1, e.message)
                    }
                })
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
                                trades.push(sub)
                                console.log('m->c', sub)
                            }
                        })
                    }
                }
                catch (e) {
                    console.log('money', m, 'currency', c, e.message)
                }
            })
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
                                trades.push(sub)
                                console.log('c->m', sub)
                            }
                        })
                    }
                }
                catch (e) {
                    console.log('currency', c, 'money', m, e.message)
                }
            })
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
                                trades.push(sub)
                                console.log('m->m', sub)
                            }
                        })
                    }
                }
                catch (e) {
                    console.log('money', m, 'money1', m1, e.message)
                }
            })
            })
        } 
    })
})

setTimeout(() => {console.log('cool'), 20000})

// https://www.cryptocompare.com/api/data/coinlist/