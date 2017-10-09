# socket-streamer
Grab data from Poloniex Push API, reconstruct orderbook in Redis.  
Subscribe to [Market Name] channel from Redis to get real-time orderbook snapshot with limited depth (defaults to 128).  
### Start:
```
gulp build
node lib/p-streamer.js
```
### Options:
```
    -V, --version               output the version number
    -r, --redis <redisUrl>      Redis URL [redis://localhost:6379]
    -w, --ws <wsUrl>            WebSocket URL [wss://api2.poloniex.com]
    -p, --prefix <redisPrefix>  Redis Prefix [orderbook]
    -v, --version <apiVersion>  Poloniex API Version [2]
    -h, --help                  output usage information
```