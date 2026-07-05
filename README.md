# homebridge-zafro-ac

A [Homebridge](https://homebridge.io) plugin that brings **Zafro / i4season
Wi-Fi air conditioners** (model `90045EAC0` and similar combo units) into Apple
HomeKit.

These units ship with a Google Home integration and the Zafro app, but no
HomeKit support and no public API. This plugin talks directly to the device's
cloud broker over **MQTT-over-WebSockets**, the same channel the official app
uses, so you get native Home app + Siri control: power, target temperature,
current room temperature, fan speed, humidity, panel light, and Dry/Fan modes.

> **Cloud dependency:** like the Zafro app itself, this plugin relies on the
> i4season / nbrowan cloud broker. If the vendor rotates your account
> credentials you'll need to refresh them (see below). There is no local API on
> these devices.

## Features

- Power on/off
- Target temperature (Cooling threshold) — handles the device's whole-°F values
- Current room temperature (real ambient reading)
- Fan speed
- Relative humidity (as a separate sensor tile)
- Panel display light (as a Lightbulb)
- Dry / Fan mode switches (modes HomeKit's thermostat model can't express)
- Real-time state: changes made in the Zafro app appear in Home instantly

## Installation

Install through the Homebridge UI ("Plugins" tab, search for it once published),
or from GitHub:

```
sudo hb-service add homebridge-zafro-ac@github:YOUR_GITHUB_USER/homebridge-zafro-ac
```

## Configuration

Add an accessory block to your `config.json` (see `config.example.json`):

| Field | Required | Description |
|---|---|---|
| `accessory` | yes | Must be `ZafroAC` |
| `name` | yes | Display name in Home |
| `host` | yes | Broker host, e.g. `zafro.nbrowan.com` |
| `username` | yes | MQTT username (see below) |
| `password` | yes | MQTT password (see below) |
| `sn` | yes | Device serial number |
| `userTag` | yes | `app_` + your numeric user id, e.g. `app_9376` |
| `vendor` | no | Defaults to `I4SEASON` |
| `windMax` | no | Number of fan levels (default 4) |
| `pollSeconds` | no | State poll interval (default 60) |
| `exposeLight` | no | Show panel light (default true) |
| `exposeModeSwitches` | no | Show Dry/Fan switches (default true) |
| `modeMap` | no | Override mode integers, e.g. `{"cool":1,"dry":2,"fan":3}` |

### Getting your credentials

The `username`, `password`, `sn`, and `userTag` come from the app's cloud
account. Capture the response of the app's `GET /iot1/mqtt/userinfo` and
`/iot1/device/list` calls (e.g. with an HTTPS proxy or by inspecting the app),
which return the MQTT username/password, your user id, and the device serial.

## Protocol notes

- Transport: `wss://<host>:443/ws/iot1/` (MQTT 3.1.1 over WebSockets)
- Command topic (publish): `dev/<vendor>/<sn>/command/request`
- Reply topic (subscribe): `dev/<vendor>/<sn>/command/reply`
- Set state: `{"cmd":6,"sn":null,"user":"app_<id>","data":{"state":{ ... }}}`
- Poll full state: `{"cmd":3,"user":"app_<id>"}`
- Temperatures are whole °F on the wire (`tempunit:1`); the plugin converts
  to/from Celsius for HomeKit.

Key state fields: `poweron`, `temperature` (current), `templevel` (target),
`rh` (humidity), `mode`, `windlevel`, `lighton`, `childlockon`.

## License

MIT
