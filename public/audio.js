// Short, local Web Audio effects. Animation progress is the only sound clock:
// no audio timers, downloads, music, or writes to classroom records.
const STORAGE_KEY = 'supermarket.sound.enabled';
const REPEAT = new Set(['wash_orange','peel_cut','start_juicer','rice','roll','pack','water','steep','soil','fill','water_plant','feed']);

export class GameAudio {
  constructor(env = globalThis) {
    this.env = env;
    this.context = null;
    this.master = null;
    this.noise = null;
    this.events = new Map();
    this.voices = new Set();
    this.buttons = new Set();
    this._enabled = true;
    this._unlocked = false;
    this._failed = false;
    this.lastStep = -Infinity;
    this.uiOwner = {};
    this.document = env.document;
    if (this.document) {
      try { this._enabled = env.localStorage.getItem(STORAGE_KEY) !== 'off'; } catch (_) { /* Private mode is fine. */ }
    }
    this.gesture = event => { if (event.isTrusted) this.unlock(event); };
    this.visibility = () => { if (this.document.visibilityState === 'hidden') this.silence(); };
    this.document?.addEventListener('pointerdown', this.gesture, {capture:true,passive:true});
    this.document?.addEventListener('keydown', this.gesture, true);
    this.document?.addEventListener('visibilitychange', this.visibility);
    this.env.addEventListener?.('pagehide', () => this.silence());
  }

  get enabled() { return this._enabled; }
  get supported() { return !this._failed && !!(this.env.AudioContext || this.env.webkitAudioContext); }

  bindButton(button) {
    if (!button || this.buttons.has(button)) return;
    this.buttons.add(button);
    button.addEventListener('click', event => {
      this.setEnabled(!this.enabled);
      this.unlock(event);
      if (this.enabled) this.step();
    });
    this._updateButtons();
  }

  _updateButtons() {
    for (const button of this.buttons) {
      button.textContent = this.enabled ? '音效：开' : '音效：关';
      button.setAttribute('aria-pressed', String(this.enabled));
      const label = this.supported ? (this.enabled ? '关闭游戏音效' : '开启游戏音效') : '当前浏览器不支持游戏音效';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  setEnabled(value) {
    this._enabled = !!value;
    try { this.env.localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off'); } catch (_) { /* Optional preference only. */ }
    if (!this.enabled) this._silence();
    this._updateButtons();
  }

  unlock(event) {
    // Synthetic clicks must not unlock audio, even in permissive browsers.
    let active = !!event?.isTrusted;
    try { active = active || !!this.env.navigator?.userActivation?.isActive; } catch (_) { /* No activation API. */ }
    if (!active || !this.enabled || !this.supported || this.document?.visibilityState === 'hidden') return;
    try {
      if (!this.context) {
        const Audio = this.env.AudioContext || this.env.webkitAudioContext;
        this.context = new Audio();
        this.master = this.context.createGain();
        this.master.gain.value = 1.0;
        this.master.connect(this.context.destination);
        this.noise = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * 0.35), this.context.sampleRate);
        const data = this.noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const context = this.context;
      this._unlocked = context.state === 'running';
      if (!this._unlocked && context.state !== 'closed') {
        Promise.resolve(context.resume()).then(() => {
          this._unlocked = context.state === 'running';
        }).catch(() => { this._unlocked = false; });
      }
    } catch (_) {
      this._unlocked = false;
      this._failed = true;
      this._silence();
      this._updateButtons();
    }
  }

  _canPlay() {
    return this.enabled && this._unlocked && this.context?.state === 'running' && this.document?.visibilityState !== 'hidden';
  }

  _silence(owner) {
    for (const voice of [...this.voices]) {
      if (owner !== undefined && voice.owner !== owner) continue;
      this._finish(voice);
      try { voice.source.stop(); } catch (_) { /* Already ended. */ }
    }
  }

  _finish(voice) {
    this.voices.delete(voice);
    for (const node of voice.nodes) { try { node.disconnect(); } catch (_) { /* Best effort cleanup. */ } }
  }

  _voice(owner, {frequency = 440, end = frequency, length = 0.07, volume = 0.2, type = 'triangle', delay = 0, noise = false, filter = 1600} = {}) {
    if (!this._canPlay() || this.voices.size >= 12) return;
    let voice;
    try {
      const context = this.context, now = context.currentTime + delay;
      const source = noise ? context.createBufferSource() : context.createOscillator();
      const gain = context.createGain();
      voice = {owner,source,nodes:[source,gain]};
      this.voices.add(voice);
      if (noise) {
        source.buffer = this.noise;
        const color = context.createBiquadFilter();
        color.type = 'lowpass';color.frequency.value = filter;
        source.connect(color);color.connect(gain);voice.nodes.push(color);
      } else {
        source.type = type;
        source.frequency.setValueAtTime(frequency, now);
        source.frequency.exponentialRampToValueAtTime(Math.max(25,end), now + length);
        source.connect(gain);
      }
      gain.connect(this.master);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, now + length);
      source.onended = () => this._finish(voice);
      source.start(now);
      source.stop(now + length + 0.012);
    } catch (_) {
      if (voice) {
        this._finish(voice);
        try { voice.source.stop(); } catch (_) { /* A partial voice never escapes. */ }
      }
    }
  }

  _effect(kind, owner) {
    const tone = (frequency,end,length = 0.07,volume = 0.2,type = 'triangle',delay = 0) => this._voice(owner,{frequency,end,length,volume,type,delay});
    const rustle = (length = 0.09,filter = 1800,volume = 0.2) => this._voice(owner,{noise:true,length,filter,volume});
    switch (kind) {
      case 'walk': tone(145,80,.045,.24);rustle(.035,650,.12);break;
      case 'cycle': rustle(.09,520,.1);tone(650,450,.025,.065);break;
      case 'take': tone(230,360,.09,.22,'square');break;
      case 'place': tone(190,90,.08,.28);rustle(.04,900,.14);break;
      case 'wash_orange': rustle(.18,2800,.18);tone(740,920,.07,.07);break;
      case 'peel_cut': rustle(.035,2600,.28);tone(310,170,.035,.16);break;
      case 'add_orange': tone(420,145,.11,.28,'sine');break;
      case 'start_juicer': tone(90,125,.24,.16,'sawtooth');rustle(.16,700,.13);break;
      case 'pack_juice': case 'package': tone(320,550,.06,.2);rustle(.07,1700,.18);break;
      case 'seaweed': rustle(.13,2200,.18);break;
      case 'rice': rustle(.1,1000,.2);tone(220,170,.055,.1);break;
      case 'filling': tone(350,240,.075,.22,'sine');break;
      case 'roll': rustle(.14,750,.18);break;
      case 'pack': case 'cut': rustle(.035,2400,.24);tone(430,250,.045,.16);break;
      case 'cup': tone(950,790,.09,.13,'sine');break;
      case 'water': rustle(.17,1900,.16);tone(560,680,.09,.09,'sine');break;
      case 'steep': tone(650,710,.12,.065,'sine');break;
      case 'remove_bag': tone(510,840,.09,.12,'sine');break;
      case 'lid': tone(760,420,.045,.17);break;
      case 'soil': rustle(.12,650,.2);break;
      case 'plant': tone(180,100,.1,.22);break;
      case 'fill': rustle(.1,950,.21);tone(160,110,.04,.12);break;
      case 'water_plant': rustle(.16,2400,.16);tone(860,580,.07,.08,'sine');break;
      case 'label_plant': tone(540,780,.045,.14);break;
      case 'fishfood': rustle(.08,3100,.15);tone(440,600,.04,.11);break;
      case 'open_feed': tone(420,720,.055,.16);break;
      case 'feed': tone(900,450,.065,.11,'sine');rustle(.05,2300,.1);break;
      case 'close_feed': tone(580,310,.045,.16);break;
      case 'record_feed': rustle(.07,3500,.12);tone(780,920,.035,.09);break;
      case 'success': tone(660,660,.09,.18);tone(880,880,.13,.16,'triangle',.09);break;
      case 'failure': tone(300,260,.1,.15);tone(220,180,.13,.13,'triangle',.1);break;
      case 'warning': tone(520,440,.09,.13,'triangle');break;
      default: tone(480,560,.05,.13);
    }
  }

  step(kind = 'action') {
    if (!this._canPlay() || this.context.currentTime - this.lastStep < .075) return;
    this.lastStep = this.context.currentTime;
    this._silence(this.uiOwner);
    this._voice(this.uiOwner,{frequency:kind === 'end' ? 740 : kind === 'start' ? 520 : 620,end:kind === 'end' ? 880 : 680,length:.055,volume:.18});
  }

  result(success) {
    this._silence(this.uiOwner);
    this._effect(success ? 'success' : 'failure',this.uiOwner);
  }

  startEvent(owner, event, {duration = 1000} = {}) {
    this.stopEvent(owner);
    if (!event) return;
    const kind = event.type === 'delivery' ? (event.status === 'spoiled' ? 'failure' : 'success') : event.type === 'action' ? event.actionId : event.type === 'walk' && event.chapterId === 4 ? 'cycle' : event.type;
    const walk = kind === 'walk' || kind === 'cycle';
    const count = walk ? Math.max(2,Math.min(24,(event.path?.length || 3) * 2 - 2)) : 4;
    this.events.set(owner,{kind,paused:false,elapsed:0,bucket:0,duration, count,lastSound:this.context?.currentTime ?? -Infinity,repeat:walk || REPEAT.has(kind)});
    this._effect(event.roadDelay ? 'warning' : kind,owner);
  }

  advanceEvent(owner, elapsed, duration) {
    const event = this.events.get(owner);
    if (!event || event.paused || !Number.isFinite(elapsed)) return;
    event.elapsed = Math.max(0,elapsed);
    const length = Number.isFinite(duration) && duration > 0 ? duration : event.duration;
    const interval = Math.max(140,Math.min(400,length / event.count));
    const bucket = Math.floor(event.elapsed / interval);
    if (bucket <= event.bucket) return;
    event.bucket = bucket; // Skip missed beats rather than queueing them.
    if (!event.repeat || event.elapsed >= length || !this._canPlay() || this.context.currentTime - event.lastSound < .12) return;
    event.lastSound = this.context.currentTime;
    this._effect(event.kind,owner);
  }

  pauseEvent(owner) {
    const event = this.events.get(owner);
    if (event) event.paused = true;
    this._silence(owner);
  }
  resumeEvent(owner) {
    const event = this.events.get(owner);
    if (event) {event.paused = false;event.lastSound = this.context?.currentTime ?? -Infinity;}
  }
  stopEvent(owner) { this._silence(owner);this.events.delete(owner); }
  silence() { this._silence(); }
  stopAll() { this._silence();this.events.clear(); }
}

export const gameAudio = new GameAudio();
