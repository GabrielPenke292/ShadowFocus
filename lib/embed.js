// Controle de um player do YouTube embutido via postMessage (protocolo da IFrame API),
// sem carregar scripts remotos — o que o Manifest V3 não permite.

const YT_ORIGIN = 'https://www.youtube.com';

export const State = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

export class YouTubeEmbed extends EventTarget {
  constructor(container, videoId) {
    super();
    this.ready = false;
    this.state = State.UNSTARTED;
    this.duration = 0;
    this.rate = 1;
    this.volume = 100;
    this.muted = false;
    this.baseTime = 0;
    this.baseStamp = performance.now();
    this.pending = [];

    const params = new URLSearchParams({
      enablejsapi: '1',
      origin: location.origin,
      widget_referrer: location.origin,
      controls: '0',
      disablekb: '1',
      playsinline: '1',
      rel: '0',
      iv_load_policy: '3',
    });
    this.iframe = document.createElement('iframe');
    this.iframe.src = `${YT_ORIGIN}/embed/${videoId}?${params}`;
    this.iframe.allow = 'autoplay; encrypted-media';
    this.iframe.title = 'YouTube';
    container.appendChild(this.iframe);

    window.addEventListener('message', (e) => this.onMessage(e));
    this.iframe.addEventListener('load', () => this.startListening());
  }

  post(obj) {
    this.iframe.contentWindow?.postMessage(JSON.stringify(obj), YT_ORIGIN);
  }

  // O player só começa a enviar eventos depois de receber "listening".
  startListening() {
    clearInterval(this.listenTimer);
    const send = () => this.post({ event: 'listening', id: 1, channel: 'widget' });
    send();
    this.listenTimer = setInterval(() => (this.ready ? clearInterval(this.listenTimer) : send()), 250);
  }

  command(func, args = []) {
    if (!this.ready) {
      this.pending.push([func, args]);
      return;
    }
    this.post({ event: 'command', func, args, id: 1, channel: 'widget' });
  }

  onMessage(e) {
    if (e.origin !== YT_ORIGIN || e.source !== this.iframe.contentWindow) return;
    let data;
    try {
      data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }

    switch (data?.event) {
      case 'onReady':
        if (this.ready) break;
        this.ready = true;
        for (const [func, args] of this.pending.splice(0)) this.command(func, args);
        this.dispatchEvent(new Event('ready'));
        break;
      case 'initialDelivery':
      case 'infoDelivery':
        this.applyInfo(data.info);
        break;
      case 'onStateChange':
        this.setState(data.info);
        break;
      case 'onPlaybackRateChange':
        this.setRate(data.info);
        break;
      case 'onError':
        this.dispatchEvent(new CustomEvent('error', { detail: data.info }));
        break;
    }
  }

  applyInfo(info) {
    if (!info) return;
    if (typeof info.playerState === 'number') this.setState(info.playerState);
    if (typeof info.playbackRate === 'number') this.setRate(info.playbackRate);
    if (info.duration) this.duration = info.duration;
    if (typeof info.volume === 'number' || typeof info.muted === 'boolean') {
      this.setVolumeState(info.volume ?? this.volume, info.muted ?? this.muted);
    }
    if (typeof info.currentTime === 'number') {
      // Ignora pequenas diferenças para o relógio local não "pular" para trás.
      const drift = Math.abs(info.currentTime - this.getCurrentTime());
      if (this.state !== State.PLAYING || drift > 0.25) {
        this.baseTime = info.currentTime;
        this.baseStamp = performance.now();
      }
    }
  }

  setState(s) {
    if (s === this.state) return;
    this.baseTime = this.getCurrentTime();
    this.baseStamp = performance.now();
    this.state = s;
    this.dispatchEvent(new Event('statechange'));
  }

  setRate(rate) {
    if (rate === this.rate) return;
    this.baseTime = this.getCurrentTime();
    this.baseStamp = performance.now();
    this.rate = rate;
    this.dispatchEvent(new Event('ratechange'));
  }

  // Interpola o tempo entre as atualizações do player para manter o texto fluido.
  getCurrentTime() {
    if (this.state !== State.PLAYING) return this.baseTime;
    return this.baseTime + ((performance.now() - this.baseStamp) / 1000) * this.rate;
  }

  get playing() {
    return this.state === State.PLAYING || this.state === State.BUFFERING;
  }

  play() {
    this.command('playVideo');
  }

  pause() {
    this.command('pauseVideo');
  }

  seekTo(t) {
    this.baseTime = Math.max(0, t);
    this.baseStamp = performance.now();
    this.command('seekTo', [this.baseTime, true]);
  }

  setVolumeState(volume, muted) {
    if (volume === this.volume && muted === this.muted) return;
    this.volume = volume;
    this.muted = muted;
    this.dispatchEvent(new Event('volumechange'));
  }

  // 0–100; subir o volume também tira do mudo, como no YouTube.
  setVolume(volume) {
    volume = Math.round(Math.min(100, Math.max(0, volume)));
    this.command('setVolume', [volume]);
    if (volume > 0 && this.muted) this.command('unMute');
    this.setVolumeState(volume, volume === 0 ? this.muted : false);
  }

  toggleMute() {
    const muted = !this.muted;
    this.command(muted ? 'mute' : 'unMute');
    this.setVolumeState(this.volume, muted);
  }

  setPlaybackRate(rate) {
    this.setRate(rate);
    this.command('setPlaybackRate', [rate]);
  }

  restart() {
    this.seekTo(0);
    this.play();
  }
}
