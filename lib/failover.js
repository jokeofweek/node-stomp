/*
 * stompit.Failover
 * Copyright (c) 2013 Graham Daws <graham.daws@gmail.com>
 * MIT licensed
 */

var events  = require('events');
var util    = require('./util');
var connect = require('./connect');
var qs      = require('qs');
var fs      = require('fs');

function Failover(servers, options){
    
    var defaults = {
        initialReconnectDelay: 10,
        maxReconnectDelay: 30000,
        useExponentialBackOff: true,
        reconnectDelayExponent: 2.0,
        maxReconnectAttempts: -1,
        maxReconnects: -1,
        randomize: true
    };
    
    options = util.extend({}, defaults, options);

    switch(typeof servers){
        case 'undefined':
            servers = [{}]; // default server
            break;
        case 'string':
            var uriConfig = this._parseFailoverUri(servers);
            servers = uriConfig.servers;
            util.extend(options, uriConfig.options);
            break;
        default:
            break;
    }
    
    for(var key in defaults){
        this[key] = options[key];
    }
    
    this._defaultConnectOptions = typeof options.connect === 'object' ? options.connect : {};
    
    var createConnector = this._createConnector.bind(this);
    
    this._connectors = servers.map(function(server){
        return createConnector(server);
    });
}

util.inherits(Failover, events.EventEmitter);

Failover.prototype._createConnector = function(arg){
    
    var config = util.extend({}, this._defaultConnectOptions);
    
    switch(typeof arg){
        case 'string':
            
            // extend connectHeaders object
            var serverUriConfig = this._parseServerUri(arg);        
            if(serverUriConfig.connectHeaders && config.connectHeaders){
                util.extend(serverUriConfig.connectHeaders, config.connectHeaders, serverUriConfig.connectHeaders);
            }
            
            util.extend(config, serverUriConfig);
            
            break;
        
        case 'object':
            util.extend(config, arg);
            break;
        
        default:
            throw new Error('invalid type (' + (typeof arg) + ') for server config argument');
    }
    
    return function(callback){
        return connect(config, callback);  
    };
};

Failover.prototype.addServer = function(){
    this._connectors.push(this._createConnector.apply(this, arguments));
};

Failover.prototype._getConnectorIndex = function(startIndex){
    
    var connectors = this._connectors;
    
    if(connectors.length === 0){
        return -1;
    }
    
    if(this.randomize){
        index = Math.round(Math.random() * (connectors.length - 1));
    }
    else{
        index = (startIndex + 1) % connectors.length;
    }
    
    return index;
};

Failover.prototype.getReconnectDelay = function(reconnects){
    
    return Math.min(
        this.initialReconnectDelay * (
            this.useExponentialBackOff ? 
                Math.pow(this.reconnectDelayExponent, reconnects) - 1
            : Math.min(reconnects, 1)),
        this.maxReconnectDelay
    );
};

Failover.prototype.connect = function(callback){
    
    var connectors = this._connectors;
    
    var reconnectAttempts = 0;
    var connects = 0;
    var index = 0;
    var lastError;
    
    var reconnect;
    
    var error = function(description){
        var connectError = new Error('failed to establish session' + (description ? ' (' + description + ')' : '') + (lastError && lastError.message ? ' last error: ' + lastError.message : ''));
        if(lastError){
            connectError.connectError = lastError;
        }
        callback(connectError);
    };
    
    if(connectors.length === 0){
        error('no server addresses configured');
        return;
    }
    
    var self = this;
    
    var connect = function(){
        
        var connector = connectors[index];
        
        var client = connector(function(error){
            
            if(error){
                
                if(self.listeners('error').length > 0){
                    self.emit('error', error);
                }
                
                lastError = error;
                reconnect();
                return;
            }
            
            lastError = null; 
            reconnectAttempts = 0;
            connects += 1;
            
            callback(null, client, reconnect);
        });
    };
    
    reconnect = function(){
        
        if(self.maxReconnects !== -1 && connects > self.maxReconnects){
            error('too many reconnects');
            return;
        }
        
        reconnectAttempts += 1;
        
        if(self.maxReconnectAttempts !== -1 && reconnectAttempts >= self.maxReconnectAttempts){
            error('tried ' + reconnectAttempts + ' connect attempts');
            return;
        }
        
        index = self._getConnectorIndex(index);
        
        setTimeout(connect, self.getReconnectDelay(reconnectAttempts));
    };
    
    connect();
};

Failover.prototype._parseFailoverUri = function(uri){
    
    var serverList = uri;
    var optionsQueryString = null;
    
    var comps = uri.match(/^failover:\(([^\)]*)\)(\?.*)?$/);
    
    if(comps){
        serverList = comps[1];
        optionsQueryString = comps[2] ? comps[2].substring(1) : void 0;
    }
    
    var servers = serverList.length > 0 ? serverList.split(',') : [];
    
    var parseString = function(value){
        value = '' + value;
        var valueLC = value.toLowerCase();
        if(valueLC === 'false'){
            value = false;
        }
        else if(valueLC === 'true'){
            value = true;
        }
        else{
            var num = parseFloat(value, 10);
            if(!isNaN(num)){
                value = num; 
            }
        }
        return value;
    };
    
    var parseAggregate = function(object){
        var out = {};
        for(var key in object){
            var value = object[key];
            var type = typeof value;
            if(type === 'object' || type === 'array'){
                value = parseAggregate(value);
            }
            else{
                value = parseString(value);
            }
            out[key] = value;
        }
        return out;
    };
    
    var options = optionsQueryString ? parseAggregate(qs.parse(optionsQueryString)) : {};
    
    var validateBool = function(name, value){
        
        if(value === void 0){
            return;
        }
        
        var type = typeof value;
        
        if(type === 'number'){
            value = Boolean(value);
        }
        
        if(typeof value !== 'boolean'){
            throw new Error('invalid ' + name + ' value \'' + options[name] + '\' (expected boolean)');
        }
        
        return value;
    };
    
    var validateFloat = function(name, value, lowest, greatest){
        
        if(value === void 0){
            return;
        }
        
        if(typeof value !== 'number' || value < lowest || value > greatest){
            throw new Error('invalid ' + name + ' value \'' + options[name] + '\' (expected number between ' + lowest + ' and ' + greatest + ')');
        }
        
        return value;
    };
    
    var boolProp = function(name){
        var value = validateBool(name, options[name]);
        if(value !== void 0){
            options[name] = value;
        }
    };
    
    var floatProp = function(name, min, max){
        var value =  validateFloat(name, options[name], min, max);
        if(value !== void 0){
            options[name] = value;
        }
    };
    
    floatProp('initialReconnectDelay',   0, Infinity);
    floatProp('maxReconnectDelay',       0, Infinity);
    floatProp('reconnectDelayExponent',  0, Infinity);
    floatProp('maxReconnectAttempts',   -1, Infinity);
    floatProp('maxReconnects',          -1, Infinity);
    
    boolProp ('useExponentialBackOff');
    boolProp ('randomize');
    
    if(typeof options.connect === 'object'){
        
        options.connect.ssl = validateBool('connect[ssl]', options.connect.ssl);
        
        var fileProp = function(name){
            
            if(!(name in options.connect)){
                return;
            }
            
            var filename = options.connect[name];
            
            if(!fs.existsSync(filename)){
                throw new Error('invalid connect[' + name + '] file not found \'' + filename + '\'');
            }
            
            options.connect[name] = fs.readFileSync(filename);        
        };
        
        fileProp('pfx');
        fileProp('key');
        fileProp('cert');
        fileProp('ca');
    }
    
    return {
        servers: servers,
        options: options
    };
};

Failover.prototype._parseServerUri = function(uri){
    
    var comps = uri.match(/^\s*((\w+):\/\/)?(([^:]+):([^@]+)@)?([\w-.]+)(:(\d+))?\s*$/);
    
    if(!comps){
        throw new Error('could not parse server uri \'' + uri + '\'');
    }
    
    var scheme   = comps[2];
    var login    = comps[4];
    var passcode = comps[5];
    var hostname = comps[6];
    var port     = comps[8];
    
    var server = {
        host: hostname,
        connectHeaders: {}
    };
    
    if(scheme !== void 0){
        server.ssl = scheme === 'ssl' || scheme === 'stomp+ssl';
    }
    
    if(port !== void 0){
        server.port = parseInt(port, 10);
    }
    
    if(login !== void 0){
        server.connectHeaders.login = login;
    }
    
    if(passcode !== void 0){
        server.connectHeaders.passcode = passcode;
    }
    
    if(scheme === 'unix' || hostname[0] === '/'){
        
        if(port !== void 0){
            throw new Error('invalid server uri \'' + uri + '\'');
        }
        
        server.path = hostname;
        server.ssl = false;
    }
    
    return server;
};

module.exports = Failover;
