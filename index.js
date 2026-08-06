'use strict';

/**
 * homebridge-zafro-ac
 * ------------------------------------------------------------------
 * Homebridge accessory plugin for Zafro / i4season Wi-Fi air
 * conditioners using the vendor cloud MQTT-over-WebSockets service.
 * Supports configurable device models through Homebridge settings.
 *
 * Protocol notes:
 *   Protocol compatibility based on observed vendor application traffic.
 *   Requires access to the i4season / nbrowan cloud broker.
 *
 * MQTT transport:
 *   wss://<host>:443/ws/iot1/
 *
 * Topics:
 *   Publish:
 *     dev/<vendor>/<sn>/command/request
 *
 *   Subscribe:
 *     dev/<vendor>/<sn>/command/reply
 *
 * Commands:
 *
 *   Poll device state:
 *     {
 *       "cmd":3,
 *       "user":"app_<id>"
 *     }
 *
 *   Set device state:
 *     {
 *       "cmd":6,
 *       "sn":null,
 *       "user":"app_<id>",
 *       "data":{
 *         "state":{
 *           "<key>":"<value>"
 *         }
 *       }
 *     }
 *
 * Temperature:
 *   Device reports whole Fahrenheit values (tempunit:1).
 *   HomeKit uses Celsius internally; conversion is performed
 *   automatically when reading and writing temperatures.
 *
 * Supported state fields:
 *   poweron       - Power state
 *   temperature   - Current room temperature
 *   templevel     - Target temperature
 *   rh            - Relative humidity
 *   mode          - Cool/Dry/Fan mode
 *   windlevel     - Fan speed level
 *   lighton       - Display/panel light
 *   childlockon   - Child lock state
 *
 * HomeKit services:
 *   - HeaterCooler (main AC control)
 *   - Humidity sensor
 *   - Panel light
 *   - Dry mode switch
 *   - Fan mode switch
 * ------------------------------------------------------------------
 */

const mqtt = require('mqtt');

let Service, Characteristic;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  api.registerAccessory('homebridge-zafro-ac', 'ZafroAC', ZafroAC);
};

const f2c = f => (f - 32) * 5 / 9;
const c2f = c => Math.round(c * 9 / 5 + 32);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

class ZafroAC {

  constructor(log, config, api) {

    this.log = log;
    this.api = api;
    this.name = config.name || 'Air Conditioner';
    this.model = config.model || '90045EAC0';

    this.host = config.host || 'zafro.nbrowan.com';
    this.wsPath = config.wsPath || '/ws/iot1/';
    this.username = config.username;
    this.password = config.password;
    this.sn = config.sn;
    this.vendor = config.vendor || 'I4SEASON';
    this.userTag = config.userTag || 'app_0';

    if (!this.username || !this.password || !this.sn || !this.userTag) {
      throw new Error('ZafroAC requires username, password and sn');
    }

    this.uuid = api.hap.uuid.generate(this.sn);

    this.windMax = Number(config.windMax) || 4;
    this.tempMinC = config.tempMinC ?? 16;
    this.tempMaxC = config.tempMaxC ?? 30;
    this.pollInterval = (config.pollSeconds || 60) * 1000;

    this.MODE = Object.assign({
      cool: 1,
      dry: 2,
      fan: 3
    }, config.modeMap || {});

    this.exposeLight = config.exposeLight !== false;
    this.exposeModeSwitches = config.exposeModeSwitches !== false;

    this.state = {
      poweron: false,
      temperature: 72,
      templevel: 72,
      rh: 50,
      mode: this.MODE.cool,
      windlevel: 1,
      lighton: true,
      childlockon: false
    };

    this.allowedFields = [
      'poweron',
      'temperature',
      'templevel',
      'rh',
      'mode',
      'windlevel',
      'lighton',
      'childlockon'
    ];

    this.reqTopic =
      `dev/${this.vendor}/${this.sn}/command/request`;

    this.replyTopic =
      `dev/${this.vendor}/${this.sn}/command/reply`;

    this.pendingState = {};
    this.commandTimer = null;

    this.services = [];

    this._buildServices();
    this._connect();

    api.on('shutdown', () => this._shutdown());
  }

  // ---------------- MQTT ----------------
  _connect() {

    const url =
      `wss://${this.host}:443${this.wsPath}`;

    const clientId =
      `homebridge-zafro-${Math.random().toString(16).slice(2,10)}`;

    this.log.info(`Connecting to Zafro MQTT broker`);

    this.client = mqtt.connect(url, {
      username: this.username,
      password: this.password,
      clientId,
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
      resubscribe: true,
      rejectUnauthorized: true
    });

    this.client.on('end', () => {
	  this.log.warn('MQTT client stopped');
	});

    this.client.on('connect', () => {

      this.log.info('Zafro MQTT connected');

      this.client.subscribe(
        this.replyTopic,
        { qos: 0 },
        err => {
          if (err)
            this.log.error('Subscribe:', err.message);
        }
      );

      this._poll();

      clearInterval(this.pollTimer);

      this.pollTimer = setInterval(
        () => this._poll(),
        this.pollInterval
      );

    });

    this.client.on('message', (topic, payload) => {

      if (topic !== this.replyTopic)
        return;

      let msg;

      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }

      this._updateState(msg);

    });

    this.client.on('error', err => {

	  if (err.message.includes('Not authorized')) {
	    this.log.error(
	      'MQTT authentication failed. Check username/password.'
	    );
	    return;
	  }

	  this.log.error(
	    'MQTT connection error:',
	    err.message
	  );

	});

    this.client.on('offline', () =>
      this.log.warn('Zafro MQTT offline')
    );

    this.client.on('reconnect', () =>
      this.log.debug('Zafro reconnecting')
    );

  }

  _poll() {
    this._publish({
      cmd: 3,
      user: this.userTag
    });
  }

  _publish(data) {

    if (!this.client || !this.client.connected)
      return;

    this.client.publish(
      this.reqTopic,
      JSON.stringify(data),
      { qos: 0 },
      err => {
        if (err)
          this.log.error('Publish:', err.message);
      }
    );
  }

  _setState(patch) {

    Object.assign(
      this.pendingState,
      patch
    );

    clearTimeout(this.commandTimer);

    this.commandTimer = setTimeout(() => {

      const state = this.pendingState;

      this.pendingState = {};

      this._publish({
        cmd: 6,
        sn: null,
        user: this.userTag,
        data: {
          state
        }
      });

    }, 250);

  }

  _updateState(msg) {

    if (!msg || typeof msg.result !== 'object')
      return;

    for (const key of this.allowedFields) {

      if (msg.result[key] !== undefined)
        this.state[key] = msg.result[key];

    }

    this._refresh();

  }

  // ---------------- HomeKit ----------------

  _buildServices() {

    this.info = new Service.AccessoryInformation();

    this.info
      .setCharacteristic(
        Characteristic.Manufacturer,
        'i4season / Zafro'
      )
      .setCharacteristic(
		  Characteristic.Model,
		  this.model
		)
      .setCharacteristic(
        Characteristic.SerialNumber,
        this.sn
      );

    this.services.push(this.info);

    const hc = new Service.HeaterCooler(
      this.name,
      this.uuid
    );

    this.hc = hc;

    hc.setPrimaryService(true);

    hc.getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.state.poweron ? 1 : 0
      )
      .onSet(v =>
        this._setState({
          poweron: !!v
        })
      );

    hc.getCharacteristic(
      Characteristic.CurrentTemperature
    )
      .onGet(() =>
        f2c(this.state.temperature)
      );

    hc.getCharacteristic(
      Characteristic.CurrentHeaterCoolerState
    )
      .onGet(() =>
        this._currentHCState()
      );

    hc.getCharacteristic(
      Characteristic.TargetHeaterCoolerState
    )
      .setProps({
        validValues: [
          Characteristic.TargetHeaterCoolerState.COOL
        ]
      })
      .onGet(() =>
        Characteristic.TargetHeaterCoolerState.COOL
      )
      .onSet(() =>
        this._setState({
          mode: this.MODE.cool
        })
      );

    hc.getCharacteristic(
      Characteristic.CoolingThresholdTemperature
    )
      .setProps({
        minValue: this.tempMinC,
        maxValue: this.tempMaxC,
        minStep: 0.5
      })
      .onGet(() =>
        clamp(
          f2c(this.state.templevel),
          this.tempMinC,
          this.tempMaxC
        )
      )
      .onSet(c =>
        this._setState({
          templevel: clamp(
            c2f(c),
            c2f(this.tempMinC),
            c2f(this.tempMaxC)
          )
        })
      );

    hc.getCharacteristic(
      Characteristic.RotationSpeed
    )
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: Math.floor(100 / this.windMax)
      })
      .onGet(() =>
        (this.state.windlevel / this.windMax) * 100
      )
      .onSet(pct =>
        this._setState({
          windlevel: clamp(
            Math.round(
              pct / 100 * this.windMax
            ),
            1,
            this.windMax
          )
        })
      );

    hc.getCharacteristic(
      Characteristic.LockPhysicalControls
    )
      .onGet(() =>
        this.state.childlockon ? 1 : 0
      )
      .onSet(v =>
        this._setState({
          childlockon: !!v
        })
      );

    hc.getCharacteristic(
      Characteristic.CurrentRelativeHumidity
    )
      .onGet(() =>
        this.state.rh
      );

    hc.getCharacteristic(
      Characteristic.TemperatureDisplayUnits
    )
      .onGet(() =>
        Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      );

    this.services.push(hc);

    // Humidity sensor

    this.humidity =
      new Service.HumiditySensor(
        `${this.name} Humidity Sensor`
      );

    this.humidity
      .getCharacteristic(
        Characteristic.CurrentRelativeHumidity
      )
      .onGet(() =>
        this.state.rh
      );

    this.services.push(this.humidity);

    // Panel light

    if (this.exposeLight) {

      this.light =
        new Service.Lightbulb(
          `${this.name} Light`
        );

      this.light
        .getCharacteristic(
          Characteristic.On
        )
        .onGet(() =>
          !!this.state.lighton
        )
        .onSet(v =>
          this._setState({
            lighton: !!v
          })
        );

      this.services.push(this.light);

    }

    // Dry/Fan switches

    if (this.exposeModeSwitches) {

      this.drySwitch =
        new Service.Switch(
          `${this.name} Dry Mode`,
          'dry'
        );

      this.drySwitch
        .getCharacteristic(
          Characteristic.On
        )
        .onGet(() =>
          this.state.mode === this.MODE.dry
        )
        .onSet(v =>
          this._setState({
            mode: v
              ? this.MODE.dry
              : this.MODE.cool
          })
        );

      this.services.push(this.drySwitch);

      this.fanSwitch =
        new Service.Switch(
          `${this.name} Fan Only`,
          'fan'
        );

      this.fanSwitch
        .getCharacteristic(
          Characteristic.On
        )
        .onGet(() =>
          this.state.mode === this.MODE.fan
        )
        .onSet(v =>
          this._setState({
            mode: v
              ? this.MODE.fan
              : this.MODE.cool
          })
        );

      this.services.push(this.fanSwitch);

    }

  }

  _currentHCState() {

    const S =
      Characteristic.CurrentHeaterCoolerState;

    if (!this.state.poweron)
      return S.INACTIVE;

    if (this.state.mode === this.MODE.cool)
      return S.COOLING;

    return S.IDLE;

  }

  _refresh() {

    if (!this.hc)
      return;

    const C = Characteristic;

    this.hc.updateCharacteristic(
      C.Active,
      this.state.poweron ? 1 : 0
    );

    this.hc.updateCharacteristic(
      C.CurrentTemperature,
      f2c(this.state.temperature)
    );


    this.hc.updateCharacteristic(
      C.CurrentHeaterCoolerState,
      this._currentHCState()
    );

    this.hc.updateCharacteristic(
      C.CoolingThresholdTemperature,
      clamp(
        f2c(this.state.templevel),
        this.tempMinC,
        this.tempMaxC
      )
    );

    this.hc.updateCharacteristic(
      C.RotationSpeed,
      (this.state.windlevel / this.windMax) * 100
    );


    this.hc.updateCharacteristic(
      C.LockPhysicalControls,
      this.state.childlockon ? 1 : 0
    );

    this.hc.updateCharacteristic(
      C.CurrentRelativeHumidity,
      this.state.rh
    );

    if (this.humidity) {

      this.humidity.updateCharacteristic(
        C.CurrentRelativeHumidity,
        this.state.rh
      );

    }

    if (this.light) {

      this.light.updateCharacteristic(
        C.On,
        !!this.state.lighton
      );

    }

    if (this.drySwitch) {

      this.drySwitch.updateCharacteristic(
        C.On,
        this.state.mode === this.MODE.dry
      );

    }

    if (this.fanSwitch) {

      this.fanSwitch.updateCharacteristic(
        C.On,
        this.state.mode === this.MODE.fan
      );

    }

  }

  _shutdown() {

    clearInterval(this.pollTimer);

    clearTimeout(this.commandTimer);

    if (this.client) {

      this.log.info(
        'Closing Zafro MQTT connection'
      );

      this.client.end(true);

    }

  }

  getServices() {

    return this.services;

  }

}
