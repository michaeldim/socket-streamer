var autobahn = require('autobahn')

var wsuri = "wss://api2.poloniex.com"

var connection = new autobahn.Connection({
  url: wsuri,
  realm: "realm1"
})

connection.onopen = session => {
	console.log("Websocket connection opened")

	function marketEvent (args, kwargs) {
		console.log('args', args, 'kwargs', kwargs)
	}

    /*
	function tickerEvent (args,kwargs) {
		console.log(args)
	}
	function trollboxEvent (args,kwargs) {
		console.log(args)
	}
		*/
		
	session.send(JSON.stringify({command: 'subscribe', channel: 1000, userID: 10717089}))
	// session.subscribe('BTC_ZEC', marketEvent)
	// session.subscribe('XMR_DASH', marketEvent)
	// session.subscribe('ticker', tickerEvent)
	// session.subscribe('trollbox', trollboxEvent)
}

connection.onclose = function () {
  console.log("Websocket connection closed")
}
		       
connection.open()