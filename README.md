# homebridge-zafro-ac

[![homebridge-plugin](https://badgen.net/badge/homebridge/plugin)](https://github.com/homebridge/homebridge)

A [Homebridge](https://homebridge.io) plugin that adds **Zafro / i4season Wi-Fi air conditioners** to Apple HomeKit.

Supports models including:

- `90045EAC0`
- Similar Zafro / i4season cloud-connected air conditioners

This plugin communicates with the vendor cloud service using the MQTT-over-WebSockets protocol used by the official Zafro / i4season application.

The protocol was reverse-engineered from application communication traffic.

> **Cloud dependency**
>
> This plugin requires access to the i4season / nbrowan cloud MQTT service.
>
> It does not provide local LAN control.

---

## Credits

This project is based on the original work by:

- Robby Dzielinski  
  https://github.com/rdzielinski

The current maintainer, carcani, forked and enhanced the project with additional
features, protocol improvements, and HomeKit service improvements.

Enhancements include:

- MQTT-over-WebSockets communication
- Improved state synchronization
- Temperature conversion handling
- Fan speed support
- Humidity reporting
- Panel light control
- Dry mode support
- Fan-only mode support
- Child lock support
- Improved HomeKit service handling

---

## Features

✅ Apple HomeKit integration  
✅ Siri support  
✅ Power on/off control  
✅ Cooling temperature control  
✅ Current room temperature  
✅ Fan speed control  
✅ Relative humidity sensor  
✅ Display/panel light control  
✅ Dry mode switch  
✅ Fan-only mode switch  
✅ Child lock switch  
✅ Automatic state polling  
✅ Synchronization with Zafro app changes  

---

# Installation

## Homebridge UI

1. Open Homebridge UI
2. Go to:

```
Plugins
```

3. Search:

```
homebridge-zafro-ac
```

4. Install the plugin
5. Restart Homebridge

---

## Manual installation

```bash
sudo npm install -g homebridge-zafro-ac
```

---

# Configuration

Add the accessory to your Homebridge `config.json`:

```json
{
  "accessories": [
    {
      "accessory": "ZafroAC",

      "name": "Bedroom AC",

      "host": "zafro.nbrowan.com",
      "wsPath": "/ws/iot1/",

      "username": "YOUR_MQTT_USERNAME",
      "password": "YOUR_MQTT_PASSWORD",

      "sn": "YOUR_DEVICE_SERIAL",
      "model": "90045EAC0",
      "vendor": "I4SEASON",

      "userTag": "app_YOUR_USER_ID",

      "windMax": 4,

      "tempMinC": 16,
      "tempMaxC": 30,

      "pollSeconds": 60,

      "exposeLight": true,
      "exposeModeSwitches": true,
      "exposeChildLock": true,

      "modeMap": {
        "cool": 1,
        "dry": 2,
        "fan": 3
      }
    }
  ]
}
```

---

# Configuration Options

| Option | Required | Default | Description |
|---|---|---|---|
| `accessory` | Yes | `ZafroAC` | Homebridge accessory identifier |
| `name` | Yes | Air Conditioner | HomeKit accessory name |
| `host` | No | `zafro.nbrowan.com` | MQTT WebSocket broker |
| `wsPath` | No | `/ws/iot1/` | MQTT WebSocket path |
| `username` | Yes | - | MQTT username |
| `password` | Yes | - | MQTT password |
| `sn` | Yes | - | Device serial number |
| `model` | No | `90045EAC0` | Device model |
| `vendor` | No | `I4SEASON` | Vendor identifier |
| `userTag` | Yes | - | Application user identifier |
| `windMax` | No | `4` | Maximum fan speed level |
| `tempMinC` | No | `16` | Minimum HomeKit temperature |
| `tempMaxC` | No | `30` | Maximum HomeKit temperature |
| `pollSeconds` | No | `60` | Device polling interval |
| `exposeLight` | No | `true` | Expose display light switch |
| `exposeModeSwitches` | No | `true` | Expose dry/fan switches |
| `exposeChildLock` | No | `true` | Expose child lock switch |
| `modeMap` | No | See example | Device mode mapping |

---

# MQTT Credentials

The plugin requires MQTT credentials from the official Zafro / i4season application.

Required:

```
MQTT username
MQTT password
Device serial number
User ID
```

The plugin uses:

```
userTag = app_<user_id>
```

Example:

```
app_9376
```

These values can be obtained by inspecting the application API traffic.

Typical endpoints:

```
GET /iot1/mqtt/userinfo

GET /iot1/device/list
```

---

# Protocol Information

Communication uses:

```
MQTT 3.1.1 over WebSockets
```

Connection:

```
wss://<host>:443/ws/iot1/
```

Publish topic:

```
dev/<vendor>/<sn>/command/request
```

Subscribe topic:

```
dev/<vendor>/<sn>/command/reply
```

---

# Commands

## Poll Device State

```json
{
  "cmd": 3,
  "user": "app_9376"
}
```

---

## Set Device State

Example:

```json
{
  "cmd": 6,
  "sn": null,
  "user": "app_9376",
  "data": {
    "state": {
      "poweron": true
    }
  }
}
```

---

# Temperature Handling

The device reports temperatures as Fahrenheit values.

Example:

```
72°F
```

Conversion:

```
Device → HomeKit

°F → °C
```

and:

```
HomeKit → Device

°C → °F
```

HomeKit displays temperature according to Apple Home settings.

---

# Supported Device Fields

| Field | Description |
|---|---|
| `poweron` | AC power state |
| `temperature` | Current room temperature |
| `templevel` | Target temperature |
| `rh` | Relative humidity |
| `mode` | Cooling / Dry / Fan mode |
| `windlevel` | Fan speed |
| `lighton` | Display light |
| `childlockon` | Child lock |

---

# HomeKit Services

The plugin exposes:

## Main Air Conditioner

Service:

```
HeaterCooler
```

Provides:

- Power
- Cooling mode
- Temperature control
- Fan speed
- Current temperature
- Humidity

---

## Additional Services

Humidity:

```
Humidity Sensor
```

Panel:

```
Lightbulb
```

Modes:

```
Dry Mode Switch
Fan Only Switch
```

Security:

```
Child Lock Switch
```

---

# Troubleshooting

## AC appears but does not respond

Verify:

- MQTT username
- MQTT password
- Device serial number
- userTag
- Device is visible in Zafro app

---

## Wrong temperature values

Confirm the device reports:

```
tempunit:1
```

The plugin expects Fahrenheit input from the device.

---

## HomeKit shows duplicate accessories

Remove cached HomeKit accessories:

1. Stop Homebridge

```bash
hb-service stop
```

2. Remove cached accessory data:

```
~/.homebridge/accessories
```

3. Restart Homebridge:

```bash
hb-service start
```

---

# Development

Clone repository:

```bash
git clone https://github.com/carcani/homebridge-zafro-ac.git

cd homebridge-zafro-ac
```

Install dependencies:

```bash
npm install
```

Run debug:

```bash
homebridge -D
```

---

# Contributors

Original project:

- rdzielinski

Enhancements and maintenance:

- carcani

---

# License

MIT License
