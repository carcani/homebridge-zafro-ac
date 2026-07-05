'use strict';

/**
 * homebridge-zafro-ac
 * ------------------------------------------------------------------
 * Homebridge accessory plugin for Zafro / i4season Wi-Fi air
 * conditioners (model 90045EAC0 and similar) that talk MQTT-over-
 * WebSockets to the nbrowan / ssiloc cloud.
 *
 * Protocol (reverse-engineered):
 *   transport : wss://<host>:443/ws/iot1/
 *   cmd topic : dev/<vendor>/<sn>/command/request   (we publish)
 *   reply top.: dev/<vendor>/<sn>/command/reply      (we subscribe)
 *   command   : {"cmd":6,"sn":null,"user":"app_<uid>",
 *                "data":{"state":{<key>:<val>}}}
 *   poll      : {"cmd":3,"user":"app_<uid>"}  -> full state snapshot
 *   reply     : {"cmd":4|3,"result":{...state..., "origin":0|1}}
 *
 * The device reports temperatures in whole °F (tempunit:1). HomeKit
 * always works in °C internally, so we convert on every read/write.
 * ------------------------------------------------------------------
 */

const mqtt = require('mqtt');

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('homebridge-zafro-ac', 'ZafroAC', ZafroAC);
};

// ---- temperature helpers ------------------------------------------
const f2c = (f) => (f - 32) * 5 / 9;
const c2f = (c) => Math.round(c * 9 / 5 + 32); // device wants whole °F
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

class ZafroAC {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.name = config.name || 'Air Conditioner';

    // --- connection / identity (from config) ---
    this.host = config.host || 'zafro.nbrowan.com';
    this.wsPath = config.wsPath || '/ws/iot1/';
    this.username = config.username;
    this.password = config.password;
    this.sn = config.sn;
    this.vendor = config.vendor || 'I4SEASON';
    this.userTag = config.userTag || 'app_0';

    // --- tunables (safe defaults; adjust after testing) ---
    this.windMax = config.windMax || 4;          // fan speed levels
    this.tempMinC = config.tempMinC ?? 16;        // ~61°F
    this.tempMaxC = config.tempMaxC ?? 30;        // ~86°F
    this.pollInterval = (config.pollSeconds || 60) * 1000;
    // mode enum: cool/dry/fan integers on the device
    this.MODE = Object.assign({ cool: 1, dry: 2, fan: 3 }, config.modeMap || {});
    this.exposeLight = config.exposeLight !== false;
    this.exposeModeSwitches = config.exposeModeSwitches !== false;

    if (!this.username || !this.password || !this.sn) {
      this.log.error('Missing required config: username, password, sn.');
    }

    // last-known device state
    this.state = {
      poweron: false, temperature: 21, templevel: 72,
      rh: 50, mode: this.MODE.cool, windlevel: 1,
      lighton: true, childlockon: false, wrong: 0,
    };

    this.reqTopic = `dev/${this.vendor}/${this.sn}/command/request`;
    this.replyTopic = `dev/${this.vendor}/${this.sn}/command/reply`;

    this._buildServices();
    this._connect();

    api.on('shutdown', () => { try { this.client && this.client.end(true); } catch (e) {} });
  }

  // ================================================================
  //  MQTT
  // ================================================================
  _connect() {
    const url = `wss://${this.host}:443${this.wsPath}`;
    const clientId = 'homebridge-zafro-' + Math.random().toString(16).slice(2, 10);
    this.log.info(`Connecting to ${url}`);

    this.client = mqtt.connect(url, {
      username: this.username,
      password: this.password,
      clientId,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      rejectUnauthorized: false,
    });

    this.client.on('connect', () => {
      this.log.info('Connected to Zafro broker.');
      this.client.subscribe(this.replyTopic, { qos: 0 }, (err) => {
        if (err) this.log.error('Subscribe failed:', err.message);
      });
      this._poll();                       // initial full-state fetch
      clearInterval(this._pollTimer);
      this._pollTimer = setInterval(() => this._poll(), this.pollInterval);
    });

    this.client.on('message', (topic, payload) => {
      if (topic !== this.replyTopic) return;
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      if (msg && msg.result && typeof msg.result === 'object') {
        Object.assign(this.state, msg.result);
        this._refresh();
      }
    });

    this.client.on('error', (e) => this.log.error('MQTT error:', e.message));
    this.client.on('close', () => this.log.debug('MQTT connection closed.'));
    this.client.on('reconnect', () => this.log.debug('MQTT reconnecting...'));
  }

  _poll() {
    this._publish({ cmd: 3, user: this.userTag });
  }

  _publish(obj) {
    if (!this.client || !this.client.connected) return;
    this.client.publish(this.reqTopic, JSON.stringify(obj), { qos: 0 });
  }

  // send a state change: {cmd:6, sn:null, user, data:{state:{...}}}
  _setState(patch) {
    Object.assign(this.state, patch); // optimistic
    this._publish({ cmd: 6, sn: null, user: this.userTag, data: { state: patch } });
  }

  // ================================================================
  //  HomeKit services
  // ================================================================
  _buildServices() {
    this.services = [];

    // --- Accessory information ---
    this.info = new Service.AccessoryInformation();
    this.info
      .setCharacteristic(Characteristic.Manufacturer, 'i4season / Zafro')
      .setCharacteristic(Characteristic.Model, '90045EAC0')
      .setCharacteristic(Characteristic.SerialNumber, this.sn || 'unknown');
    this.services.push(this.info);

    // --- HeaterCooler (main) ---
    const hc = new Service.HeaterCooler(this.name);
    this.hc = hc;

    hc.getCharacteristic(Characteristic.Active)
      .onGet(() => this.state.poweron ? 1 : 0)
      .onSet((v) => this._setState({ poweron: !!v }));

    hc.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => f2c(this.state.temperature));

    hc.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this._currentHCState());

    // Cool-only device: restrict target state to COOL
    hc.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [Characteristic.TargetHeaterCoolerState.COOL],
      })
      .onGet(() => Characteristic.TargetHeaterCoolerState.COOL)
      .onSet(() => this._setState({ mode: this.MODE.cool }));

    hc.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: this.tempMinC, maxValue: this.tempMaxC, minStep: 0.5 })
      .onGet(() => clamp(f2c(this.state.templevel), this.tempMinC, this.tempMaxC))
      .onSet((c) => this._setState({ templevel: clamp(c2f(c), 61, 86) }));

    hc.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: Math.floor(100 / this.windMax) })
      .onGet(() => (this.state.windlevel / this.windMax) * 100)
      .onSet((pct) => {
        const w = clamp(Math.round(pct / 100 * this.windMax), 1, this.windMax);
        this._setState({ windlevel: w });
      });

    hc.getCharacteristic(Characteristic.LockPhysicalControls)
      .onGet(() => this.state.childlockon ? 1 : 0)
      .onSet((v) => this._setState({ childlockon: !!v }));

    hc.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.state.rh);

    hc.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.FAHRENHEIT);

    this.services.push(hc);

    // --- Humidity sensor (nice standalone tile) ---
    this.humidity = new Service.HumiditySensor(this.name + ' Humidity');
    this.humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.state.rh);
    this.services.push(this.humidity);

    // --- Panel light ---
    if (this.exposeLight) {
      this.light = new Service.Lightbulb(this.name + ' Light');
      this.light.getCharacteristic(Characteristic.On)
        .onGet(() => !!this.state.lighton)
        .onSet((v) => this._setState({ lighton: !!v }));
      this.services.push(this.light);
    }

    // --- Dry / Fan mode switches (device modes HomeKit can't express) ---
    if (this.exposeModeSwitches) {
      this.drySwitch = new Service.Switch(this.name + ' Dry', 'dry');
      this.drySwitch.getCharacteristic(Characteristic.On)
        .onGet(() => this.state.mode === this.MODE.dry)
        .onSet((v) => this._setState({ mode: v ? this.MODE.dry : this.MODE.cool }));
      this.services.push(this.drySwitch);

      this.fanSwitch = new Service.Switch(this.name + ' Fan', 'fan');
      this.fanSwitch.getCharacteristic(Characteristic.On)
        .onGet(() => this.state.mode === this.MODE.fan)
        .onSet((v) => this._setState({ mode: v ? this.MODE.fan : this.MODE.cool }));
      this.services.push(this.fanSwitch);
    }
  }

  _currentHCState() {
    const S = Characteristic.CurrentHeaterCoolerState;
    if (!this.state.poweron) return S.INACTIVE;
    return this.state.mode === this.MODE.cool ? S.COOLING : S.IDLE;
  }

  // push latest device state into every characteristic
  _refresh() {
    if (!this.hc) return;
    const C = Characteristic;
    this.hc.updateCharacteristic(C.Active, this.state.poweron ? 1 : 0);
    this.hc.updateCharacteristic(C.CurrentTemperature, f2c(this.state.temperature));
    this.hc.updateCharacteristic(C.CurrentHeaterCoolerState, this._currentHCState());
    this.hc.updateCharacteristic(C.CoolingThresholdTemperature,
      clamp(f2c(this.state.templevel), this.tempMinC, this.tempMaxC));
    this.hc.updateCharacteristic(C.RotationSpeed, (this.state.windlevel / this.windMax) * 100);
    this.hc.updateCharacteristic(C.LockPhysicalControls, this.state.childlockon ? 1 : 0);
    this.hc.updateCharacteristic(C.CurrentRelativeHumidity, this.state.rh);

    if (this.humidity)
      this.humidity.updateCharacteristic(C.CurrentRelativeHumidity, this.state.rh);
    if (this.light)
      this.light.updateCharacteristic(C.On, !!this.state.lighton);
    if (this.drySwitch)
      this.drySwitch.updateCharacteristic(C.On, this.state.mode === this.MODE.dry);
    if (this.fanSwitch)
      this.fanSwitch.updateCharacteristic(C.On, this.state.mode === this.MODE.fan);
  }

  getServices() { return this.services; }
}
