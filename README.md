# socket-streamer
Grab data from Poloniex Push API, reconstruct orderbook in Redis.  
Subscribe to [Market Name] channel from Redis to get real-time orderbook snapshot with limited depth (defaults to 128).  
Subscribe to [Trade Channel] channel (defaults to poloniex_trade) to get trade info.
### Start:
```
gulp build
node lib/p-streamer.js
```
### Start with PM2:
```
gulp build
pm2 start lib/p-streamer.js
```
### Options:
```
    -V, --version               output the version number
    -r, --redis <redisUrl>      Redis URL [redis://localhost:6379]
    -m, --mongo <mongoUrl>      Mongodb URL [mongodb://localhost:27017/streamer]
    -w, --ws <wsUrl>            WebSocket URL [wss://api2.poloniex.com]
    -p, --prefix <redisPrefix>  Redis Prefix [orderbook]
    -t, --trade <tradeChannel>  Trade info Redis channel [poloniex_trade]
    -v, --version <apiVersion>  Poloniex API Version [2]
    -h, --help                  output usage information
```
