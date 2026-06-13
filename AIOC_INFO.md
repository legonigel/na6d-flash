# AIOC Technical Reference

This document serves as a reference for the hardware details and WebHID configuration interface of the All-In-One Cable (AIOC).

## USB Identifiers

- **Vendor ID (VID):** `0x1209` (Intercreate)
- **Product ID (PID):** `0x7388` (AIOC)

## Registers

The internal configuration registers of the AIOC can be read and written via USB HID Feature Reports.

| Register Name   | Address | Description                                              |
| :-------------- | :------ | :------------------------------------------------------- |
| `MAGIC`         | `0x00`  | Device magic number                                      |
| `USBID`         | `0x08`  | Custom USB VID/PID override settings                     |
| `AIOC_IOMUX0`   | `0x24`  | IOMUX settings for AIOC channel 0                        |
| `AIOC_IOMUX1`   | `0x25`  | IOMUX settings for AIOC channel 1                        |
| `CM108_IOMUX0`  | `0x44`  | CM108 GPIO mapping 0                                     |
| `CM108_IOMUX1`  | `0x45`  | CM108 GPIO mapping 1                                     |
| `CM108_IOMUX2`  | `0x46`  | CM108 GPIO mapping 2                                     |
| `CM108_IOMUX3`  | `0x47`  | CM108 GPIO mapping 3                                     |
| `SERIAL_CTRL`   | `0x60`  | Serial console settings                                  |
| `SERIAL_IOMUX0` | `0x64`  | Serial IOMUX mapping 0                                   |
| `SERIAL_IOMUX1` | `0x65`  | Serial IOMUX mapping 1                                   |
| `SERIAL_IOMUX2` | `0x66`  | Serial IOMUX mapping 2                                   |
| `SERIAL_IOMUX3` | `0x67`  | Serial IOMUX mapping 3                                   |
| `AUDIO_RX`      | `0x72`  | Audio RX gain configuration                              |
| `AUDIO_TX`      | `0x78`  | Audio TX boost configuration                             |
| `VPTT_LVLCTRL`  | `0x82`  | Virtual PTT level thresholds                             |
| `VPTT_TIMCTRL`  | `0x84`  | Virtual PTT timer settings                               |
| `VCOS_LVLCTRL`  | `0x92`  | Virtual Carrier Operated Squelch level                   |
| `VCOS_TIMCTRL`  | `0x94`  | Virtual Carrier Operated Squelch timeout                 |
| `FOXHUNT_CTRL`  | `0xA0`  | Foxhunt control register (WPM, interval, volume, enable) |
| `FOXHUNT_MSG0`  | `0xA2`  | Foxhunt Morse code message bytes 0-3                     |
| `FOXHUNT_MSG1`  | `0xA3`  | Foxhunt Morse code message bytes 4-7                     |
| `FOXHUNT_MSG2`  | `0xA4`  | Foxhunt Morse code message bytes 8-11                    |
| `FOXHUNT_MSG3`  | `0xA5`  | Foxhunt Morse code message bytes 12-15                   |

## Command Flags

Commands dictate the type of register action when sending a HID Feature Report.

- `NONE` (`0x00`): No strobe (read mode)
- `WRITESTROBE` (`0x01`): Writes the value to the specified register address
- `DEFAULTS` (`0x10`): Resets registers to factory defaults
- `REBOOT` (`0x20`): Reboots the device (exits to normal mode or triggers bootloader depending on state)
- `RECALL` (`0x40`): Restores the configuration from flash memory
- `STORE` (`0x80`): Commits the current register configuration to persistent flash memory

## HID Protocol Structure

To communicate with the configuration interface:

1.  Open the device with **VID `0x1209`** and **PID `0x7388`**.
2.  Use **Report ID `0`** for all feature report transfers.

### Writing a Register

To write a register, send a feature report with **Command `0x01`** (`WRITESTROBE`), the target **Register Address**, and the **Value** (4 bytes, little-endian).

On WebHID:

```javascript
// Data layout (excluding Report ID byte, WebHID prepends it)
// Byte 0: Command (0x01)
// Byte 1: Register Address (e.g. 0x72 for AUDIO_RX)
// Bytes 2-5: Value (Uint32, little-endian)
const payload = new Uint8Array(6);
const view = new DataView(payload.buffer);
payload[0] = 0x01; // WRITESTROBE
payload[1] = registerAddress;
view.setUint32(2, value, true); // true for little-endian
await device.sendFeatureReport(0, payload);
```

### Reading a Register

To read a register, first send a feature report with **Command `0x00`** (`NONE`) and the target **Register Address** to prompt the device, then read back the feature report.

On WebHID:

```javascript
// Step 1: Send the read request
const payload = new Uint8Array(6);
payload[0] = 0x00; // NONE
payload[1] = registerAddress;
// Bytes 2-5 are 0
await device.sendFeatureReport(0, payload);

// Step 2: Receive the response
const response = await device.receiveFeatureReport(0);
// response is a DataView. The WebHID API prepends the Report ID at index 0 on receive:
// Byte 0: Report ID (0)
// Byte 1: Command (0x00)
// Byte 2: Register Address
// Bytes 3-6: Value (Uint32, little-endian)
const value = response.getUint32(3, true);
```
