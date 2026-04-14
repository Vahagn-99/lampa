(function(){
    'use strict';

    if(window.__skipIntroLoaded) return;
    window.__skipIntroLoaded = true;

    var API_THEINTRODB = 'https://api.theintrodb.org/v2';
    var API_INTRODB = 'https://api.introdb.app';
    var API_TIMEOUT = 5000;
    var CACHE_TTL = 7 * 86400 * 1000;
    var COUNTDOWN_SECONDS = 4;

    var SEGMENT_LABELS = {
        intro:   'Пропустить заставку',
        recap:   'Пропустить рекап',
        credits: 'Пропустить титры',
        preview: 'Пропустить превью'
    };
    var SEGMENT_TYPES = ['intro', 'recap', 'credits', 'preview'];

    var Settings = {
        init: function(){
            Lampa.SettingsApi.addComponent({
                component: 'skip_intro',
                name: 'Пропуск заставок',
                icon: '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>'
            });
            Lampa.SettingsApi.addParam({component:'skip_intro',param:{name:'skip_intro_enabled',type:'trigger',default:true},field:{name:'Включить плагин',description:'Показывать кнопку пропуска заставок и титров'}});
            Lampa.SettingsApi.addParam({component:'skip_intro',param:{name:'skip_intro_auto',type:'trigger',default:false},field:{name:'Всегда автопропуск',description:'Всегда перематывать без кнопки (для всех сериалов)'}});
            Lampa.SettingsApi.addParam({component:'skip_intro',param:{name:'skip_intro_type_intro',type:'trigger',default:true},field:{name:'Пропускать заставку (intro)'}});
            Lampa.SettingsApi.addParam({component:'skip_intro',param:{name:'skip_intro_type_recap',type:'trigger',default:true},field:{name:'Пропускать рекап (recap)'}});
            Lampa.SettingsApi.addParam({component:'skip_intro',param:{name:'skip_intro_type_credits',type:'trigger',default:true},field:{name:'Пропускать титры (credits)'}});
            Lampa.SettingsApi.addParam({component:'skip_intro',param:{name:'skip_intro_type_preview',type:'trigger',default:false},field:{name:'Пропускать превью (preview)'}});
        },
        isEnabled: function(){ return Lampa.Storage.field('skip_intro_enabled') !== false; },
        isAutoSkip: function(){ return Lampa.Storage.field('skip_intro_auto') === true; },
        isTypeEnabled: function(type){ return Lampa.Storage.field('skip_intro_type_' + type) !== false; }
    };

    var SmartSkipMemory = {
        _storageKey: 'skip_intro_smart',
        _getAll: function(){
            try {
                var data = Lampa.Storage.get(this._storageKey, '{}');
                if(typeof data === 'string') data = JSON.parse(data);
                return data || {};
            } catch(e){ return {}; }
        },
        _saveAll: function(data){
            try { Lampa.Storage.set(this._storageKey, JSON.stringify(data)); } catch(e){}
        },
        hasSkipped: function(tmdb_id, segmentType){
            var all = this._getAll();
            return all[tmdb_id + '_' + segmentType] === true;
        },
        rememberSkip: function(tmdb_id, segmentType){
            var all = this._getAll();
            all[tmdb_id + '_' + segmentType] = true;
            this._saveAll(all);
            console.log('[SkipIntro] Smart skip remembered for', tmdb_id, segmentType);
        },
        forgetSkip: function(tmdb_id, segmentType){
            var all = this._getAll();
            delete all[tmdb_id + '_' + segmentType];
            this._saveAll(all);
            console.log('[SkipIntro] Smart skip forgotten for', tmdb_id, segmentType);
        }
    };

    var Cache = {
        _key: function(t,s,e){ return 'skip_'+t+'_s'+s+'_e'+e; },
        get: function(t,s,e){
            try {
                var raw = localStorage.getItem(this._key(t,s,e));
                if(!raw) return null;
                var d = JSON.parse(raw);
                if(!d||!d._ts) return null;
                if(Date.now()-d._ts>CACHE_TTL){ localStorage.removeItem(this._key(t,s,e)); return null; }
                return d.segments||[];
            } catch(x){ return null; }
        },
        set: function(t,s,e,segs){
            try { localStorage.setItem(this._key(t,s,e), JSON.stringify({segments:segs,_ts:Date.now()})); } catch(x){}
        }
    };

    var ApiClient = {
        _fetchWithTimeout: function(url, timeout){
            return new Promise(function(resolve, reject){
                var aborted=false;
                var timer=setTimeout(function(){aborted=true;reject(new Error('timeout'));},timeout);
                var xhr=new XMLHttpRequest();
                xhr.open('GET',url,true);
                xhr.setRequestHeader('Accept','application/json');
                xhr.onreadystatechange=function(){
                    if(xhr.readyState===4){
                        clearTimeout(timer);
                        if(aborted)return;
                        if(xhr.status>=200&&xhr.status<300){try{resolve(JSON.parse(xhr.responseText));}catch(e){reject(e);}}
                        else if(xhr.status===204||xhr.status===404){resolve(null);}
                        else{reject(new Error('HTTP '+xhr.status));}
                    }
                };
                xhr.onerror=function(){clearTimeout(timer);reject(new Error('network'));};
                xhr.send();
            });
        },
        _normalizeTheIntroDB: function(json){
            var segs=[];
            if(!json)return segs;
            SEGMENT_TYPES.forEach(function(type){
                var arr=json[type];
                if(Array.isArray(arr)){arr.forEach(function(s){
                    var st=s.start_ms!=null?s.start_ms/1000:(s.start||0);
                    var en=s.end_ms!=null?s.end_ms/1000:(s.end||0);
                    if(en>st)segs.push({type:type,start:st,end:en});
                });}
            });
            return segs;
        },
        _normalizeIntroDB: function(intro, credits){
            var segs=[];
            if(intro&&intro.start!=null&&intro.end!=null&&intro.end>intro.start) segs.push({type:'intro',start:intro.start,end:intro.end});
            if(credits&&credits.start!=null&&credits.end!=null&&credits.end>credits.start) segs.push({type:'credits',start:credits.start,end:credits.end});
            return segs;
        },
        fetchTheIntroDB: function(tmdb_id,season,episode){
            var url=API_THEINTRODB+'/media?tmdb_id='+tmdb_id+'&season='+season+'&episode='+episode;
            var self=this;
            return this._fetchWithTimeout(url,API_TIMEOUT).then(function(j){return self._normalizeTheIntroDB(j);});
        },
        fetchIntroDB: function(tmdb_id,imdb_id,season,episode){
            var p=imdb_id?'imdb='+imdb_id:'tmdb='+tmdb_id;
            var self=this;
            var u1=API_INTRODB+'/get_intros?'+p+'&season='+season+'&episode='+episode;
            var u2=API_INTRODB+'/get_credits?'+p+'&season='+season+'&episode='+episode;
            return Promise.all([
                self._fetchWithTimeout(u1,API_TIMEOUT).catch(function(){return null;}),
                self._fetchWithTimeout(u2,API_TIMEOUT).catch(function(){return null;})
            ]).then(function(r){return self._normalizeIntroDB(r[0],r[1]);});
        },
        load: function(tmdb_id,imdb_id,season,episode){
            var cached=Cache.get(tmdb_id,season,episode);
            if(cached!==null)return Promise.resolve(cached);
            var self=this;
            return this.fetchTheIntroDB(tmdb_id,season,episode).then(function(segs){
                if(segs&&segs.length>0){Cache.set(tmdb_id,season,episode,segs);return segs;}
                return self.fetchIntroDB(tmdb_id,imdb_id,season,episode).then(function(s){Cache.set(tmdb_id,season,episode,s||[]);return s||[];});
            }).catch(function(){
                return self.fetchIntroDB(tmdb_id,imdb_id,season,episode).then(function(s){Cache.set(tmdb_id,season,episode,s||[]);return s||[];}).catch(function(){return[];});
            });
        }
    };

    var SkipButton = {
        _button:null,_visible:false,_fadeTimer:null,_countdownInterval:null,_progressBar:null,_mode:null,

        _injectCSS: function(){
            if(document.getElementById('skip-intro-css'))return;
            var s=document.createElement('style');
            s.id='skip-intro-css';
            s.textContent='.skip-intro-button{position:absolute;right:30px;bottom:100px;padding:0;background:rgba(0,0,0,.75);border:2px solid rgba(255,255,255,.3);border-radius:6px;color:#fff;font-size:1.1em;cursor:pointer;z-index:9999;transition:opacity .3s ease,border-color .3s ease;opacity:0;pointer-events:none;outline:none;font-family:inherit;line-height:1.3;white-space:nowrap;overflow:hidden;display:flex;flex-direction:column}.skip-intro-button.visible{opacity:1;pointer-events:auto}.skip-intro-button:focus,.skip-intro-button:hover{border-color:#fff}.skip-intro-content{display:flex;align-items:center;padding:12px 24px;gap:8px;position:relative;z-index:2}.skip-intro-content:hover{background:rgba(255,255,255,.1)}.skip-intro-icon{width:18px;height:18px;flex-shrink:0}.skip-intro-progress{position:absolute;bottom:0;left:0;height:3px;background:rgba(255,255,255,.9);border-radius:0 0 4px 4px;transition:width .1s linear;z-index:3}.skip-intro-cancel{display:none;padding:8px 24px;text-align:center;font-size:.85em;color:rgba(255,255,255,.6);border-top:1px solid rgba(255,255,255,.15);cursor:pointer;position:relative;z-index:2}.skip-intro-cancel:hover{color:#fff;background:rgba(255,255,255,.1)}.skip-intro-button.countdown .skip-intro-cancel{display:block}';
            document.head.appendChild(s);
        },

        showNormal: function(label, onSkip){
            this._clearCountdown();
            this._injectCSS();
            this._mode='normal';
            if(this._button){
                this._updateLabel(label);
                this._button._onSkip=onSkip;
                this._button.classList.remove('countdown');
                if(this._progressBar)this._progressBar.style.width='0%';
                if(!this._visible)this._setVisible(true);
                return;
            }
            this._createButton(label,onSkip,false);
        },

        showCountdown: function(label, onSkip, onCancel){
            this._clearCountdown();
            this._injectCSS();
            this._mode='countdown';
            if(this._button){
                this._updateLabel(label);
                this._button._onSkip=onSkip;
                this._button._onCancel=onCancel;
                this._button.classList.add('countdown');
                if(this._progressBar)this._progressBar.style.width='0%';
                if(!this._visible)this._setVisible(true);
                this._startCountdown(onSkip);
                return;
            }
            this._createButton(label,onSkip,true,onCancel);
            this._startCountdown(onSkip);
        },

        _createButton: function(label,onSkip,withCancel,onCancel){
            var btn=document.createElement('div');
            btn.className='skip-intro-button'+(withCancel?' countdown':'');
            btn.setAttribute('tabindex','1');

            var content=document.createElement('div');
            content.className='skip-intro-content';
            var text=document.createElement('span');
            text.className='skip-intro-label';
            text.textContent=label;
            content.appendChild(text);

            var icon=document.createElementNS('http://www.w3.org/2000/svg','svg');
            icon.setAttribute('class','skip-intro-icon');
            icon.setAttribute('viewBox','0 0 24 24');
            icon.setAttribute('fill','currentColor');
            var p1=document.createElementNS('http://www.w3.org/2000/svg','path');
            p1.setAttribute('d','M5.5 18.5V5.5L14 12L5.5 18.5Z');
            var p2=document.createElementNS('http://www.w3.org/2000/svg','path');
            p2.setAttribute('d','M14 18.5V5.5L22.5 12L14 18.5Z');
            icon.appendChild(p1);icon.appendChild(p2);
            content.appendChild(icon);
            btn.appendChild(content);

            var progress=document.createElement('div');
            progress.className='skip-intro-progress';
            progress.style.width='0%';
            btn.appendChild(progress);
            this._progressBar=progress;

            var cancel=document.createElement('div');
            cancel.className='skip-intro-cancel';
            cancel.textContent='Отменить';
            btn.appendChild(cancel);

            btn._onSkip=onSkip;
            btn._onCancel=onCancel||null;

            content.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();if(btn._onSkip)btn._onSkip();});
            cancel.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();if(btn._onCancel)btn._onCancel();});

            btn.addEventListener('keydown',function(e){
                if(e.keyCode===13||e.keyCode===32){e.preventDefault();e.stopPropagation();if(btn._onSkip)btn._onSkip();}
                if(e.keyCode===8||e.keyCode===27){e.preventDefault();e.stopPropagation();if(btn._onCancel)btn._onCancel();}
            });

            this._button=btn;
            var pl=document.querySelector('.player');
            if(pl)pl.appendChild(btn);else document.body.appendChild(btn);
            var self=this;
            setTimeout(function(){self._setVisible(true);},50);
        },

        _updateLabel: function(label){
            if(!this._button)return;
            var el=this._button.querySelector('.skip-intro-label');
            if(el)el.textContent=label;
        },

        _startCountdown: function(onComplete){
            var self=this;
            var startTime=Date.now();
            var duration=COUNTDOWN_SECONDS*1000;
            this._countdownInterval=setInterval(function(){
                var elapsed=Date.now()-startTime;
                var progress=Math.min(1,elapsed/duration);
                if(self._progressBar)self._progressBar.style.width=(progress*100)+'%';
                if(elapsed>=duration){
                    self._clearCountdown();
                    if(onComplete)onComplete();
                }
            },50);
        },

        _clearCountdown: function(){
            if(this._countdownInterval){clearInterval(this._countdownInterval);this._countdownInterval=null;}
        },

        hide: function(){
            this._clearCountdown();
            if(!this._button)return;
            this._setVisible(false);
            var btn=this._button,self=this;
            clearTimeout(this._fadeTimer);
            this._fadeTimer=setTimeout(function(){
                if(btn&&btn.parentNode)btn.parentNode.removeChild(btn);
                if(self._button===btn){self._button=null;self._progressBar=null;}
            },350);
        },

        destroy: function(){
            this._clearCountdown();
            clearTimeout(this._fadeTimer);
            if(this._button&&this._button.parentNode)this._button.parentNode.removeChild(this._button);
            this._button=null;this._progressBar=null;this._visible=false;this._mode=null;
        },

        _setVisible: function(state){
            this._visible=state;
            if(this._button){if(state)this._button.classList.add('visible');else this._button.classList.remove('visible');}
        },

        isVisible: function(){return this._visible;},
        focus: function(){if(this._button)this._button.focus();}
    };

    var SegmentChecker = {
        findActive: function(segments, currentTime){
            if(!segments||!segments.length)return null;
            for(var i=0;i<segments.length;i++){
                var seg=segments[i];
                if(currentTime>=seg.start&&currentTime<seg.end)return seg;
            }
            return null;
        }
    };

    var SkipIntroPlugin = {
        _segments:[],_activeSegment:null,_lastSkippedSegment:null,_currentData:null,_currentTmdbId:null,

        init: function(){
            Settings.init();
            var self=this;
            Lampa.Player.listener.follow('start',function(data){self._onPlayerStart(data);});
            Lampa.Player.listener.follow('destroy',function(){self._onDestroy();});
            if(Lampa.PlayerVideo&&Lampa.PlayerVideo.listener){
                Lampa.PlayerVideo.listener.follow('timeupdate',function(e){self._onTimeUpdate(e);});
            }
            console.log('[SkipIntro] Plugin v1.1 initialized (smart auto-skip)');
        },

        _extractMeta: function(data){
            var r={tmdb_id:null,imdb_id:null,season:null,episode:null,is_series:false};
            var card=data.card||null;
            if(!card){try{var a=Lampa.Activity.active();if(a&&a.card)card=a.card;if(!card&&a&&a.movie)card=a.movie;}catch(e){}}
            if(card){
                r.tmdb_id=card.id||null;r.imdb_id=card.imdb_id||null;
                if(card.name&&!card.title)r.is_series=true;
                if(card.number_of_seasons||card.first_air_date)r.is_series=true;
            }
            if(data.season!=null)r.season=parseInt(data.season);
            if(data.episode!=null)r.episode=parseInt(data.episode);
            if((r.season==null||r.episode==null)&&data.title){
                var m=data.title.match(/[Ss](\d+)[Ee](\d+)/);
                if(m){if(r.season==null)r.season=parseInt(m[1]);if(r.episode==null)r.episode=parseInt(m[2]);}
            }
            if(data.playlist&&Array.isArray(data.playlist)){
                var cu=data.url;
                for(var i=0;i<data.playlist.length;i++){
                    var it=data.playlist[i],iu=typeof it.url==='string'?it.url:'';
                    if(iu===cu||i===0){
                        if(it.season!=null&&r.season==null)r.season=parseInt(it.season);
                        if(it.episode!=null&&r.episode==null)r.episode=parseInt(it.episode);
                        if(it.s!=null&&r.season==null)r.season=parseInt(it.s);
                        if(it.e!=null&&r.episode==null)r.episode=parseInt(it.e);
                        if(iu===cu)break;
                    }
                }
            }
            if(r.season!=null&&r.episode!=null)r.is_series=true;
            return r;
        },

        _onPlayerStart: function(data){
            this._segments=[];this._activeSegment=null;this._lastSkippedSegment=null;this._currentData=data;this._currentTmdbId=null;
            if(!Settings.isEnabled())return;
            var meta=this._extractMeta(data);
            if(!meta.tmdb_id||!meta.is_series||meta.season==null||meta.episode==null){
                console.log('[SkipIntro] Not a series or missing metadata, skipping',meta);return;
            }
            this._currentTmdbId=meta.tmdb_id;
            console.log('[SkipIntro] Loading segments for TMDB:',meta.tmdb_id,'S'+meta.season+'E'+meta.episode);
            var self=this;
            ApiClient.load(meta.tmdb_id,meta.imdb_id,meta.season,meta.episode).then(function(segs){
                if(self._currentData!==data)return;
                self._segments=segs;
                console.log('[SkipIntro] Loaded segments:',segs.length,segs);
            }).catch(function(e){console.log('[SkipIntro] Error loading segments:',e);});
        },

        _onTimeUpdate: function(e){
            if(!Settings.isEnabled()||!this._segments.length)return;
            var ct=e.current;
            if(ct==null||isNaN(ct))return;
            var seg=SegmentChecker.findActive(this._segments,ct);
            if(seg){
                if(!Settings.isTypeEnabled(seg.type)){if(this._activeSegment)this._hideButton();return;}
                if(this._lastSkippedSegment===seg)return;
                if(Settings.isAutoSkip()){this._doSkip(seg,true);return;}
                if(this._activeSegment!==seg){
                    this._activeSegment=seg;
                    var tid=this._currentTmdbId;
                    if(tid&&SmartSkipMemory.hasSkipped(tid,seg.type)){
                        this._showCountdownButton(seg);
                    } else {
                        this._showNormalButton(seg);
                    }
                }
            } else {
                if(this._activeSegment)this._hideButton();
            }
        },

        _showNormalButton: function(seg){
            var label=SEGMENT_LABELS[seg.type]||'Пропустить';
            var self=this;
            SkipButton.showNormal(label,function(){
                if(self._currentTmdbId)SmartSkipMemory.rememberSkip(self._currentTmdbId,seg.type);
                self._doSkip(seg,false);
            });
        },

        _showCountdownButton: function(seg){
            var label=SEGMENT_LABELS[seg.type]||'Пропустить';
            var self=this;
            SkipButton.showCountdown(label,
                function(){self._doSkip(seg,true);},
                function(){
                    console.log('[SkipIntro] Auto-skip cancelled by user');
                    if(self._currentTmdbId)SmartSkipMemory.forgetSkip(self._currentTmdbId,seg.type);
                    self._lastSkippedSegment=seg;
                    SkipButton.destroy();
                    self._activeSegment=null;
                }
            );
        },

        _hideButton: function(){this._activeSegment=null;SkipButton.hide();},

        _doSkip: function(seg,silent){
            this._lastSkippedSegment=seg;this._activeSegment=null;
            SkipButton.destroy();
            try{
                var v=Lampa.PlayerVideo.video();
                if(v){var t=Math.min(seg.end,v.duration||seg.end);v.currentTime=t;console.log('[SkipIntro] Skipped',seg.type,'to',t,silent?'(auto)':'(manual)');}
            }catch(e){console.log('[SkipIntro] Error seeking:',e);}
        },

        _onDestroy: function(){
            this._segments=[];this._activeSegment=null;this._lastSkippedSegment=null;this._currentData=null;this._currentTmdbId=null;
            SkipButton.destroy();
        }
    };

    function startPlugin(){
        if(window.Lampa&&Lampa.SettingsApi&&Lampa.Player&&Lampa.Storage){SkipIntroPlugin.init();}
        else{setTimeout(startPlugin,500);}
    }

    if(window.Lampa&&Lampa.Listener){
        Lampa.Listener.follow('app',function(e){if(e.type==='ready')startPlugin();});
        setTimeout(startPlugin,1000);
    } else {
        var ri=setInterval(function(){
            if(window.Lampa&&Lampa.Listener){
                clearInterval(ri);
                Lampa.Listener.follow('app',function(e){if(e.type==='ready')startPlugin();});
                setTimeout(startPlugin,1000);
            }
        },300);
    }
})();
