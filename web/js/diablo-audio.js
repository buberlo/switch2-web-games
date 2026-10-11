(function () {
  'use strict';
  window.createDiabloAudio = function () {
    var context, sounds = Object.create(null), muted = false;
    try { var Constructor = window.AudioContext || window.webkitAudioContext; if (Constructor) context = new Constructor(); } catch (e) {}
    function resume() { if (!muted && context && context.state === 'suspended') context.resume().catch(function(){}); }
    resume();
    function item(buffer) { return {buffer:buffer,generation:0,gain:context.createGain(),panner:context.createStereoPanner ? context.createStereoPanner() : null}; }
    function stop(sound) { if (!sound) return; sound.generation++; if (sound.source) { try{sound.source.stop();}catch(e){} sound.source.disconnect(); sound.source=null; } }
    var api = {
      create_sound_raw:function(id, data, length, channels, rate) {
        if (!context) return;
        var buffer = context.createBuffer(channels,length,rate);
        for (var i=0;i<channels;i++) buffer.getChannelData(i).set(data.subarray(i*length,(i+1)*length));
        stop(sounds[id]); sounds[id]=item(Promise.resolve(buffer));
      },
      create_sound:function(id,data) {
        if (!context) return;
        var promise = new Promise(function(resolve){context.decodeAudioData(data.buffer,resolve,function(){resolve(null);});});
        stop(sounds[id]); sounds[id]=item(promise);
      },
      duplicate_sound:function(id,source) { if(context && sounds[source]) {stop(sounds[id]); sounds[id]=item(sounds[source].buffer);} },
      play_sound:function(id,volume,pan,loop) {
        var sound=sounds[id]; if(!sound || !context) return;
        stop(sound); var generation=sound.generation;
        sound.gain.gain.value=Math.pow(2,volume/1000);
        if(sound.panner) sound.panner.pan.value=1-2/(1+Math.pow(2,pan/1000));
        sound.buffer.then(function(buffer){
          if(!buffer || sound.generation!==generation || !context) return;
          var source=context.createBufferSource(); source.buffer=buffer; source.loop=!!loop;
          source.connect(sound.gain); sound.gain.disconnect();
          if(sound.panner){sound.gain.connect(sound.panner);sound.panner.disconnect();sound.panner.connect(context.destination);}
          else sound.gain.connect(context.destination);
          source.start();sound.source=source;
        }).catch(function(){});
      },
      set_volume:function(id,volume){if(sounds[id])sounds[id].gain.gain.value=Math.pow(2,volume/1000);},
      stop_sound:function(id){stop(sounds[id]);},
      delete_sound:function(id){stop(sounds[id]);delete sounds[id];}
    };
    return {
      available:!!context,
      handle:function(method,args){try{if(api[method])api[method].apply(null,args);}catch(e){}},
      resume:resume,
      mute:function(value){muted=value;if(context){if(value)context.suspend().catch(function(){});else resume();}},
      visibility:function(hidden){if(context){if(hidden)context.suspend().catch(function(){});else if(!muted)resume();}},
      stop:function(){Object.keys(sounds).forEach(function(id){stop(sounds[id]);});sounds=Object.create(null);if(context)context.close().catch(function(){});context=null;}
    };
  };
})();
