var net     = require("net");
var util    = require("./util");
var Client  = require("./client");

function connect(){
    
    var args = net._normalizeConnectArgs(arguments);
    
    var options = util.extend({
        host: "localhost",
        connectHeaders: {}
    }, args[0]);
    
    if(options.port === undefined || typeof options.port === "function"){
        options.port = 61613;
    }
    
    var cb = args[1];
    
    var client, socket, timeout;
    
    var onConnected = function(){
        
        if(timeout){
            clearTimeout(timeout);
        }
        
        client.emit("socket-connect");
        client.connect(util.extend({host: options.host}, options.connectHeaders), cb);
    };
    
    if(options.hasOwnProperty("timeout")){
        var timeout = setTimeout(function(){
            client.emit("error", client.createTransportError("connect timed out"));
        }, options.timeout);
    }
    
    socket = net.connect.apply(null, [options, onConnected]);
    
    client = new Client(socket, options);
    
    return client;
}

module.exports = connect;