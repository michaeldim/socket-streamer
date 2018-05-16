import WebSocket from 'ws'

const ws = new WebSocket('wss://api2.poloniex.com')

ws.on('open', () => {
    ws.send(JSON.stringify({command: 'subscribe', channel: 'BTC_ZEC'}))
})

ws.on('message', (msg) => {
    console.log(msg)
})

