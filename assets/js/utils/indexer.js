var start = time(), 
    lastUpdate = 0, 
    connected, 
    terminated, 
    processingInterval = 1800, 
    reportingInterval = 60, 
    watchingDataIsVisible = time(),
    leftWindowDiffTimer, 
    leftWindowDiff,
    Indexer,
    mainPid = 0,
    mediaTypeStreamsCount = mediaTypeStreamsCountTemplate,
    ParentalControl = require(path.resolve('modules/parental-control'))

var ipc = require('node-ipc'), 
    win = nw.Window.get()

ipc.config.id = 'indexer'
ipc.config.socketRoot = Store.folder + path.sep;

const connect = () => {
    ipc.connectToNet('main', () => {
        console.log('IPC connected', time())
        var events = {
            'disconnect': () => {
                console.log('detected disconnect event')
                isMainPIDRunning((err, running) => {
                    if(running){
                        connect()
                    } else {
                        terminate(true)
                    }
                })
            },
            'app-unload': () => {
                console.log('detected unload event')
                terminate(true)
            },
            'indexer-update': () => {
                init()
            },
            'indexer-register': (pid) => {
                if(pid && isNumber(pid) && pid != mainPid){
                    mainPid = pid
                }
            },
            'indexer-sync': () => {
                Config.reload()
                getActiveLists((urls) => {
                    Indexer.setLists(urls) 
                })
            },
            'indexer-adult-filter': (opts) => {
                ipc.of.main.emit('indexer-query-result', indexerAdultFilter(opts))
            },
            'indexer-filter': (opts) => {
                ipc.of.main.emit('indexer-query-result', indexerFilter(opts))
            },
            'indexer-query': (opts) => {
                ipc.of.main.emit('indexer-query-result', indexerQuery(opts))
            },
            'indexer-query-list': (opts) => {
                opts.results = indexerQueryList(opts)
                ipc.of.main.emit('indexer-query-result', opts)
            },
            'indexer-is-watching-visible': () => {
                watchingDataIsVisible = time()
            }
        }
        Object.keys(events).forEach(name => {
            ipc.of.main.on(name, events[name])
        })
        connected = true
    })
}

connect()

indexerFilter = opts => {
    if(typeof(Indexer) != 'object'){
        return setTimeout(() => {
            indexerFilter(opts)
        }, 1000)
    }
    opts.names = opts.names.filter(name => {
        if(!Indexer.has){
            console.warn('Indexer.has', Indexer, typeof(Indexer))
        }
        return Indexer.has(name, !opts.strict, true, [opts.type])
    })
    return opts
}

indexerAdultFilter = opts => {
    if(typeof(Indexer) != 'object'){
        return setTimeout(() => {
            indexerAdultFilter(opts)
        }, 1000)
    }
    let ks = Object.keys(Indexer.lists)
    opts.entries = opts.entries.map(e => {
        ks.some(u => {
            if(e.isSafe !== false){
                let found = false
                Indexer.lists[u].some(n => {
                    if(e.name == n.name || e.url == n.url){
                        found = true
                        if(n.isSafe === false){
                            e.isSafe = false
                            return true
                        }
                    }
                })
                if(!found && e.isSafe !== false && !parentalControlAllow(e, true)){
                    e.isSafe = false
                    return true
                }
            }
        })
        return e
    })
    return opts
}

indexerQuery = (opts) => {
    if(typeof(Indexer) != 'object'){
        return setTimeout(() => {
            indexerQuery(opts)
        }, 1000)
    }
    let limit = searchResultsLimit, ret = Indexer.search(opts.term, opts.matchGroup, opts.matchPartial, [opts.type], typeof(opts.adult) == 'boolean' ? opts.adult : null)        
    let maybe = searchResultsLimit > ret.results.length ? ret.maybe.slice(0, searchResultsLimit - ret.results.length) : []
    console.warn('INDEXER QUERY', searchResultsLimit, ret, opts)   
    return {uid: opts.uid, results: ret.results.slice(0, searchResultsLimit), maybe}
}

indexerQueryList = (opts) => {
    if(typeof(Indexer) != 'object'){
        return setTimeout(() => {
            indexerQueryList(opts)
        }, 1000)
    }
    return opts.url && Array.isArray(Indexer.lists[opts.url]) ? Indexer.lists[opts.url] : []
}

function terminate() {
    var debug = debugAllow(false)
    try {
        ipc.disconnect('main')
    } catch(e) {
        console.error(e)
    }
    console.log('closing', traceback())
    if(!debug){
        win.close(true)
    } else {
        console.warn('Closing prevented for debugging')
    }
}

function emitVars(){
    ipc.of.main.emit('indexer-vars', {watchingData, mediaTypeStreamsCount, leftWindowDiff, sharedListsGroups})
}

function report(){
    if(time() < (watchingDataIsVisible + (reportingInterval - 1)) || !Array.isArray(watchingData) || !watchingData.length){
        updateWatchingData(emitVars)
    } else {
        emitVars()
    }
}

function init(){
    if(!Indexer){
        ipc.of.main.emit('indexer-register')
        mediaTypeStreamsCount = Object.assign({}, mediaTypeStreamsCountTemplate)
    }
    Config.reload()
    getActiveLists((urls) => {
        console.warn('BUILD*', Config.get('search-range-size'), urls)
        if(!Indexer){
            var parentalControl = new ParentalControl()
            parentalControl.terms = parentalControlTerms()
            Indexer = new (require(path.resolve('modules/m3u-indexer')))({
                store: GStore, 
                request
            })
            Indexer.ttl = processingInterval - 30 // 30 secs tolerance from processingInterval to ensure purge caching
            Indexer.stopWords = ['tv', 'channel', 'fhd', 'hd', 'sd', 'h265', 'h.265', 'rede']
            Indexer.isSafe = (entry) => {
                return typeof(Indexer.unsafeIndex[entry.url]) == 'undefined' && parentalControl.allow(entry)
            }
            Indexer.on('stats', (stats, groups) => {
                mediaTypeStreamsCount = stats
                sharedListsGroups = groups
                report()
            })
            ipc.of.main.emit('indexer-ready')
        }
        Indexer.setLists(urls, () => {
            let cnt = 0
            Object.keys(Indexer.lists).forEach(url => {
                cnt += Indexer.lists[url].length                
            })
            if(!cnt){
                ipc.of.main.emit('indexer-empty')
            }
        }) 
    })
}

var watchingDataCBs = [], watchingDataFetching = false

function updateWatchingData(cb){
    if(typeof(Indexer) != 'object'){
        return setTimeout(() => {
            updateWatchingData(cb)
        }, 1000)
    }
    var locale = getLocale(true)
    watchingDataCBs.push(cb)
    if(!watchingDataFetching){
        watchingDataFetching = true
        var url = 'http://app.megacubo.net/stats/data/watching.' + locale + '.json'
        fetchEntries(url, (entries) => {
            if(!Array.isArray(entries)){
                entries = []
            }
            if(entries.length){
                watchingData = entries
            }
            async.eachOfLimit(entries, 2, (e, i, acb) => {
                if(isMegaURL(entries[i].url)){
                    var data = parseMegaURL(entries[i].url);
                    if(data && data.type == 'play' && data.name && data.name.length < entries[i].name.length) {
                        entries[i].name = data.name;
                    }
                }
                if(!entries[i].logo){
                    entries[i].logo = 'http://app.megacubo.net/logos/'+encodeURIComponent(entries[i].name)+'.png';
                }
                if(typeof(entries[i].mediaType) == 'undefined' || entries[i].mediaType == -1){
                    entries[i].mediaType = getMediaType(entries[i])
                }
                entries[i].label = entries[i].label.format(Lang.USER, Lang.USERS)
                entries[i].isAudio = Indexer.msi.isAudio(entries[i].url) || Indexer.msi.isRadio(entries[i].name)
                entries[i].isSafe = Indexer.isSafe(entries[i])
                acb()
            }, () => {
                watchingDataFetching = false
                watchingDataCBs.map(f => {
                    f(entries)
                })
                watchingDataCBs = []
            }) 
        }, true)
    }
}

function ready(){
    Config.reload()
    if(navigator.onLine && (Config.get('search-range-size') > 0 || getSources().length)){
        console.log('Start indexing...')
        var pop = nw.Window.get()
        pop.maximize()
        pop.hide()
        leftWindowDiffTimer = setInterval(() => {
            if(pop.x <= 0){
                clearInterval(leftWindowDiffTimer)
                try {
                    leftWindowDiff = pop.x
                    ipc.of.main.emit('indexer-load')
                } catch(e) {
                    console.error(e)
                }
            }
        }, 250)    
        init()
        setInterval(init, processingInterval * 1000)
        setInterval(report, reportingInterval * 1000)
    } else {
        setTimeout(ready, 1500)
    }
}

ready()

