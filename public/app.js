// AIOC Configuration & Flashing App
// Core logic utilizing WebHID for configuration and WebUSB for DFU flashing

// Constants matching AIOC hardware
const Register = {
    MAGIC: 0x00,
    USBID: 0x08,
    AIOC_IOMUX0: 0x24,
    AIOC_IOMUX1: 0x25,
    CM108_IOMUX0: 0x44,
    CM108_IOMUX1: 0x45,
    CM108_IOMUX2: 0x46,
    CM108_IOMUX3: 0x47,
    SERIAL_CTRL: 0x60,
    SERIAL_IOMUX0: 0x64,
    SERIAL_IOMUX1: 0x65,
    SERIAL_IOMUX2: 0x66,
    SERIAL_IOMUX3: 0x67,
    AUDIO_RX: 0x72,
    AUDIO_TX: 0x78,
    VPTT_LVLCTRL: 0x82,
    VPTT_TIMCTRL: 0x84,
    VCOS_LVLCTRL: 0x92,
    VCOS_TIMCTRL: 0x94,
    FOXHUNT_CTRL: 0xA0,
    FOXHUNT_MSG0: 0xA2,
    FOXHUNT_MSG1: 0xA3,
    FOXHUNT_MSG2: 0xA4,
    FOXHUNT_MSG3: 0xA5
};

const Command = {
    NONE: 0x00,
    WRITESTROBE: 0x01,
    DEFAULTS: 0x10,
    REBOOT: 0x20,
    RECALL: 0x40,
    STORE: 0x80
};

const PTTSource = {
    NONE: 0x00000000,
    CM108GPIO1: 0x00000001,
    CM108GPIO2: 0x00000002,
    CM108GPIO3: 0x00000004,
    CM108GPIO4: 0x00000008,
    SERIALDTR: 0x00000100,
    SERIALRTS: 0x00000200,
    SERIALDTRNRTS: 0x00000400,
    SERIALNDTRRTS: 0x00000800,
    VPTT: 0x00001000
};

const RXGain = {
    RXGAIN1X: 0x00000000,
    RXGAIN2X: 0x00000001,
    RXGAIN4X: 0x00000002,
    RXGAIN8X: 0x00000003,
    RXGAIN16X: 0x00000004
};

const TXBoost = {
    TXBOOSTOFF: 0x00000000,
    TXBOOSTON: 0x00000100
};

// Global App State
let hidDevice = null;
let dfuDevice = null;
let firmwareFile = null;
let dfuManifestationTolerant = true;
let dfuTransferSize = 1024;

// Log helper
function log(type, msg) {
    const consoleEl = document.querySelector("#terminal-output");
    if (!consoleEl) return;

    const time = new Date().toLocaleTimeString();
    const line = document.createElement("p");
    line.className = `log-entry log-${type}`;
    line.innerHTML = `<span class="log-time">[${time}]</span> <span class="log-msg">${msg}</span>`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function logInfo(msg) { log("info", msg); }
function logWarning(msg) { log("warning", msg); }
function logError(msg) { log("error", msg); }
function logDebug(msg) { log("debug", msg); }
function logSuccess(msg) { log("success", msg); }

// UI Progress logger interface for DFU
function logProgress(done, total) {
    const progressEl = document.querySelector("#dfu-progress");
    if (!progressEl) return;
    
    if (typeof total === "undefined") {
        progressEl.removeAttribute("value");
        logDebug(`Progress: ${done} bytes`);
    } else {
        progressEl.max = total;
        progressEl.value = done;
        const pct = Math.round((done / total) * 100);
        logDebug(`Progress: ${done}/${total} bytes (${pct}%)`);
    }
}

// Helper: formats hex numbers nicely
function hex16(n) {
    return "0x" + n.toString(16).padStart(4, "0").toUpperCase();
}
function hex32(n) {
    return "0x" + n.toString(16).padStart(8, "0").toUpperCase();
}

/* ==========================================================================
   WebHID Implementation (Configuration Mode)
   ========================================================================== */

async function sendHIDFeature(device, cmdCode, address, value) {
    // 6 bytes payload for Report ID 0:
    // Byte 0: Command (1 byte)
    // Byte 1: Register Address (1 byte)
    // Bytes 2-5: Value (Uint32, 4 bytes, little-endian)
    const payload = new Uint8Array(6);
    const view = new DataView(payload.buffer);
    payload[0] = cmdCode;
    payload[1] = address;
    view.setUint32(2, value, true); // little-endian
    
    await device.sendFeatureReport(0x00, payload);
}

async function readRegister(device, address) {
    await sendHIDFeature(device, Command.NONE, address, 0x00000000);
    const response = await device.receiveFeatureReport(0x00);
    
    // Response layout:
    // response.getUint8(0) -> Report ID (0)
    // response.getUint8(1) -> Command (0)
    // response.getUint8(2) -> Address
    // response.getUint32(3, true) -> Value (Uint32, little-endian)
    return response.getUint32(3, true);
}

async function writeRegister(device, address, value) {
    await sendHIDFeature(device, Command.WRITESTROBE, address, value);
}

async function connectHID() {
    const btn = document.querySelector("#btn-connect-hid");
    if (btn) btn.disabled = true;
    try {
        logInfo("Requesting AIOC HID device...");
        const devices = await navigator.hid.requestDevice({
            filters: [{ vendorId: 0x1209, productId: 0x7388 }]
        });
        
        if (devices.length === 0) {
            logWarning("No device selected.");
            if (btn) btn.disabled = false;
            return;
        }
        
        hidDevice = devices[0];
        await hidDevice.open();
        logSuccess(`Connected to HID: ${hidDevice.productName}`);
        
        // Validate if this interface supports feature reports (i.e. is the AIOC configuration interface)
        const hasFeatureReports = hidDevice.collections && hidDevice.collections.some(
            c => (c.featureReports && c.featureReports.length > 0)
        );
        
        if (!hasFeatureReports) {
            logError("Connection failed: The selected HID interface does not support feature reports.");
            logWarning("If your device is running firmware v1.3.0 or later, make sure to select the 'AIOC Configuration' interface in the browser prompt, not 'CM108'.");
            logWarning("If the configuration interface is not visible or you are on firmware v1.2.0 or older, please upgrade your AIOC firmware to v1.3.0+ using the DFU Flashing tab.");
            await hidDevice.close();
            hidDevice = null;
            if (btn) btn.disabled = false;
            return;
        }
        
        // Check magic register
        const magicVal = await readRegister(hidDevice, Register.MAGIC);
        const magicStr = String.fromCharCode(
            magicVal & 0xFF,
            (magicVal >> 8) & 0xFF,
            (magicVal >> 16) & 0xFF,
            (magicVal >> 24) & 0xFF
        );
        
        logInfo(`Device Magic: "${magicStr}" (${hex32(magicVal)})`);
        if (magicStr !== "AIOC") {
            logWarning("Device magic does not match 'AIOC'. Settings might not behave correctly.");
        }
        
        document.querySelector("#hid-status").textContent = "Connected";
        document.querySelector("#hid-status").className = "status-connected";
        if (btn) {
            btn.textContent = "Disconnect";
            btn.disabled = false;
        }
        enableHIDControls(true);
        
        // Read everything
        await readAllSettings();
    } catch (err) {
        logError(`HID connection failed: ${err.message}`);
        if (btn) {
            btn.textContent = "Connect Configurator (HID)";
            btn.disabled = false;
        }
    }
}

function disconnectHID() {
    if (hidDevice) {
        const btn = document.querySelector("#btn-connect-hid");
        if (btn) btn.disabled = true;
        hidDevice.close().then(() => {
            logInfo("HID interface closed.");
            hidDevice = null;
            document.querySelector("#hid-status").textContent = "Disconnected";
            document.querySelector("#hid-status").className = "status-disconnected";
            if (btn) {
                btn.textContent = "Connect Configurator (HID)";
                btn.disabled = false;
            }
            enableHIDControls(false);
            clearHIDFields();
        }).catch(err => {
            logError(`Error closing HID device: ${err.message}`);
            if (btn) btn.disabled = false;
        });
    }
}

function enableHIDControls(enable) {
    const fields = document.querySelectorAll("#hid-panel input, #hid-panel select, #hid-panel button:not(#btn-connect-hid)");
    fields.forEach(el => el.disabled = !enable);
}

function clearHIDFields() {
    document.querySelectorAll("#hid-panel input[type='checkbox']").forEach(el => el.checked = false);
    document.querySelectorAll("#hid-panel input[type='number'], #hid-panel input[type='text']").forEach(el => el.value = "");
    document.querySelectorAll("#hid-panel select").forEach(el => el.selectedIndex = 0);
}

async function readAllSettings() {
    if (!hidDevice) return;
    try {
        logInfo("Reading settings from AIOC registers...");
        
        // PTT1 (IOMUX0) & PTT2 (IOMUX1)
        const ptt1Val = await readRegister(hidDevice, Register.AIOC_IOMUX0);
        const ptt2Val = await readRegister(hidDevice, Register.AIOC_IOMUX1);
        updatePTTCheckboxes("ptt1", ptt1Val);
        updatePTTCheckboxes("ptt2", ptt2Val);
        logInfo(`PTT1 Sources: ${hex32(ptt1Val)} | PTT2 Sources: ${hex32(ptt2Val)}`);
        
        // Audio RX (0x72) & TX (0x78)
        const audioRx = await readRegister(hidDevice, Register.AUDIO_RX);
        const audioTx = await readRegister(hidDevice, Register.AUDIO_TX);
        document.querySelector("#audio-rx-gain").value = audioRx & 0x07; // gain index (0-4)
        document.querySelector("#audio-tx-boost").checked = (audioTx & 0x0100) !== 0;
        logInfo(`RX Gain: ${audioRx & 0x07} | TX Boost: ${(audioTx & 0x0100) !== 0 ? "ON" : "OFF"}`);
        
        // Squelch (VCOS) Level (0x92) & Timeout (0x94)
        const vcosLvl = await readRegister(hidDevice, Register.VCOS_LVLCTRL);
        const vcosTim = await readRegister(hidDevice, Register.VCOS_TIMCTRL);
        document.querySelector("#vcos-level").value = vcosLvl;
        document.querySelector("#vcos-timeout").value = vcosTim;
        logInfo(`VCOS Level: ${vcosLvl} | VCOS Timeout: ${vcosTim} ms`);
        
        // VPTT Level (0x82) & Timeout (0x84)
        const vpttLvl = await readRegister(hidDevice, Register.VPTT_LVLCTRL);
        const vpttTim = await readRegister(hidDevice, Register.VPTT_TIMCTRL);
        document.querySelector("#vptt-level").value = vpttLvl;
        document.querySelector("#vptt-timeout").value = vpttTim;
        logInfo(`VPTT Level: ${vpttLvl} | VPTT Timeout: ${vpttTim} ms`);
        
        // Foxhunt Configuration (0xA0)
        const foxCtrl = await readRegister(hidDevice, Register.FOXHUNT_CTRL);
        const volume = (foxCtrl >> 16) & 0xFFFF;
        const wpm = (foxCtrl >> 8) & 0xFF;
        const interval = foxCtrl & 0xFF;
        document.querySelector("#fox-volume").value = volume;
        document.querySelector("#fox-wpm").value = wpm;
        document.querySelector("#fox-interval").value = interval;
        logInfo(`Foxhunt Config: Vol=${volume}, Speed=${wpm} WPM, Interval=${interval}s`);
        
        // Foxhunt Morse Message (0xA2 - 0xA5)
        const msgWord0 = await readRegister(hidDevice, Register.FOXHUNT_MSG0);
        const msgWord1 = await readRegister(hidDevice, Register.FOXHUNT_MSG1);
        const msgWord2 = await readRegister(hidDevice, Register.FOXHUNT_MSG2);
        const msgWord3 = await readRegister(hidDevice, Register.FOXHUNT_MSG3);
        
        const textDecoder = new TextDecoder("ascii");
        const msgBytes = new Uint8Array(16);
        const view = new DataView(msgBytes.buffer);
        view.setUint32(0, msgWord0, true);
        view.setUint32(4, msgWord1, true);
        view.setUint32(8, msgWord2, true);
        view.setUint32(12, msgWord3, true);
        
        // Strip trailing nulls for display
        let endIdx = msgBytes.indexOf(0);
        if (endIdx === -1) endIdx = 16;
        const msgText = textDecoder.decode(msgBytes.slice(0, endIdx));
        document.querySelector("#fox-message").value = msgText;
        logInfo(`Foxhunt Message: "${msgText}"`);
        
        logSuccess("Registers loaded successfully.");
    } catch (err) {
        logError(`Failed reading registers: ${err.message}`);
    }
}

function updatePTTCheckboxes(prefix, value) {
    document.querySelectorAll(`input[id^="${prefix}-"]`).forEach(el => {
        const flagName = el.id.split("-")[1].toUpperCase();
        if (PTTSource[flagName] !== undefined) {
            el.checked = (value & PTTSource[flagName]) !== 0;
        }
    });
}

function collectPTTValue(prefix) {
    let value = 0x00000000;
    document.querySelectorAll(`input[id^="${prefix}-"]`).forEach(el => {
        if (el.checked) {
            const flagName = el.id.split("-")[1].toUpperCase();
            if (PTTSource[flagName] !== undefined) {
                value |= PTTSource[flagName];
            }
        }
    });
    return value;
}

async function writeAllSettings(store = false) {
    if (!hidDevice) {
        logError("Device not connected.");
        return;
    }
    
    try {
        logInfo("Writing settings to registers...");
        
        // PTT settings
        const ptt1Val = collectPTTValue("ptt1");
        const ptt2Val = collectPTTValue("ptt2");
        await writeRegister(hidDevice, Register.AIOC_IOMUX0, ptt1Val);
        await writeRegister(hidDevice, Register.AIOC_IOMUX1, ptt2Val);
        
        // Audio
        const rxGainIdx = parseInt(document.querySelector("#audio-rx-gain").value);
        const txBoostOn = document.querySelector("#audio-tx-boost").checked;
        await writeRegister(hidDevice, Register.AUDIO_RX, rxGainIdx);
        await writeRegister(hidDevice, Register.AUDIO_TX, txBoostOn ? TXBoost.TXBOOSTON : TXBoost.TXBOOSTOFF);
        
        // Squelch / VCOS
        const vcosLvl = parseInt(document.querySelector("#vcos-level").value) || 0;
        const vcosTim = parseInt(document.querySelector("#vcos-timeout").value) || 0;
        await writeRegister(hidDevice, Register.VCOS_LVLCTRL, vcosLvl);
        await writeRegister(hidDevice, Register.VCOS_TIMCTRL, vcosTim);
        
        // VPTT
        const vpttLvl = parseInt(document.querySelector("#vptt-level").value) || 0;
        const vpttTim = parseInt(document.querySelector("#vptt-timeout").value) || 0;
        await writeRegister(hidDevice, Register.VPTT_LVLCTRL, vpttLvl);
        await writeRegister(hidDevice, Register.VPTT_TIMCTRL, vpttTim);
        
        // Foxhunt config
        const volume = parseInt(document.querySelector("#fox-volume").value) || 0;
        const wpm = parseInt(document.querySelector("#fox-wpm").value) || 0;
        const interval = parseInt(document.querySelector("#fox-interval").value) || 0;
        const foxCtrlVal = (volume << 16) | (wpm << 8) | interval;
        await writeRegister(hidDevice, Register.FOXHUNT_CTRL, foxCtrlVal);
        
        // Foxhunt Morse Message
        const msgText = document.querySelector("#fox-message").value || "";
        const encoder = new TextEncoder();
        const asciiBytes = encoder.encode(msgText);
        const paddedBytes = new Uint8Array(16);
        paddedBytes.set(asciiBytes.slice(0, 16));
        
        const view = new DataView(paddedBytes.buffer);
        const w0 = view.getUint32(0, true);
        const w1 = view.getUint32(4, true);
        const w2 = view.getUint32(8, true);
        const w3 = view.getUint32(12, true);
        
        await writeRegister(hidDevice, Register.FOXHUNT_MSG0, w0);
        await writeRegister(hidDevice, Register.FOXHUNT_MSG1, w1);
        await writeRegister(hidDevice, Register.FOXHUNT_MSG2, w2);
        await writeRegister(hidDevice, Register.FOXHUNT_MSG3, w3);
        
        logSuccess("Settings written to device RAM successfully.");
        
        if (store) {
            logInfo("Saving settings to persistent Flash memory...");
            await sendHIDFeature(hidDevice, Command.STORE, 0, 0);
            logSuccess("Settings permanently saved.");
        }
    } catch (err) {
        logError(`Failed writing settings: ${err.message}`);
    }
}

async function loadDefaults() {
    if (!hidDevice) return;
    try {
        logInfo("Resetting AIOC registers to factory defaults...");
        await sendHIDFeature(hidDevice, Command.DEFAULTS, 0, 0);
        logSuccess("Factory defaults loaded. Reading registers...");
        await readAllSettings();
    } catch (err) {
        logError(`Failed to load defaults: ${err.message}`);
    }
}

async function rebootDevice() {
    if (!hidDevice) return;
    try {
        logInfo("Rebooting device...");
        await sendHIDFeature(hidDevice, Command.REBOOT, 0, 0);
        logSuccess("Reboot command sent.");
        disconnectHID();
    } catch (err) {
        logError(`Failed to reboot: ${err.message}`);
    }
}

/* ==========================================================================
   WebUSB DFU Implementation (Firmware Flashing Mode)
   ========================================================================== */

async function getDFUDescriptorProperties(device) {
    let configIndex = 0;
    if (device.settings && device.settings.configuration) {
        let configValue = device.settings.configuration.configurationValue;
        let index = device.device_.configurations.findIndex(c => c.configurationValue === configValue);
        if (index !== -1) {
            configIndex = index;
        }
    }
    try {
        const data = await device.readConfigurationDescriptor(configIndex);
        let configDesc = dfu.parseConfigurationDescriptor(data);
        let funcDesc = null;
        for (let desc of configDesc.descriptors) {
            if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                funcDesc = desc;
                break;
            }
        }
        if (funcDesc) {
            return {
                WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                TransferSize:          funcDesc.wTransferSize,
                DetachTimeOut:         funcDesc.wDetachTimeOut,
                DFUVersion:            funcDesc.bcdDFUVersion
            };
        }
    } catch (err) {
        logWarning(`Could not read DFU functional descriptor: ${err.message}`);
    }
    return {};
}

async function loadServerFirmware(url) {
    try {
        logInfo(`Fetching firmware from server: ${url}...`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Server returned status ${response.status}: ${response.statusText}`);
        }
        firmwareFile = await response.arrayBuffer();
        logSuccess(`Firmware loaded: ${url.split('/').pop()} (${firmwareFile.byteLength} bytes)`);
    } catch (err) {
        logError(`Failed to load firmware from server: ${err.message}`);
        firmwareFile = null;
    }
}

async function connectDFU() {
    const btn = document.querySelector("#btn-connect-dfu");
    if (btn) btn.disabled = true;
    try {
        logInfo("Scanning for USB DFU interfaces...");
        let dfu_devices = await dfu.findAllDfuInterfaces();
        
        // Filter to only match the STM32 DFU bootloader (VID: 0x0483, PID: 0xDF11)
        dfu_devices = dfu_devices.filter(d => 
            d.device_.vendorId === 0x0483 && d.device_.productId === 0xDF11
        );
        
        let selected_device = null;
        if (dfu_devices.length === 0) {
            logInfo("Requesting USB DFU device from user...");
            const rawUsbDevice = await navigator.usb.requestDevice({
                filters: [{ vendorId: 0x0483, productId: 0xDF11 }]
            });
            const interfaces = dfu.findDeviceDfuInterfaces(rawUsbDevice);
            if (interfaces.length === 0) {
                throw new Error("Selected device does not support USB DFU.");
            }
            // Use first interface
            selected_device = new dfu.Device(rawUsbDevice, interfaces[0]);
        } else if (dfu_devices.length === 1) {
            selected_device = dfu_devices[0];
        } else {
            logWarning("Multiple DFU interfaces found. Connecting to first one...");
            selected_device = dfu_devices[0];
        }
        
        logInfo("Opening DFU device...");
        await selected_device.open();
        
        // Read DFU functional descriptor details
        const desc = await getDFUDescriptorProperties(selected_device);
        
        let memorySummary = "";
        if (desc && Object.keys(desc).length > 0) {
            selected_device.properties = desc;
            dfuTransferSize = desc.TransferSize;
            dfuManifestationTolerant = desc.ManifestationTolerant;
            document.querySelector("#dfu-xfer-size").value = dfuTransferSize;
            
            logInfo(`DFU properties: Detach=${desc.WillDetach}, ManifestTolerant=${desc.ManifestationTolerant}, Upload=${desc.CanUpload}, Dnload=${desc.CanDnload}, XferSize=${desc.TransferSize}, DFUVer=${hex16(desc.DFUVersion)}`);
            
            // Convert to DfuSe.Device if DfuSe protocol is detected
            if (desc.DFUVersion === 0x011a || selected_device.settings.alternate.interfaceProtocol === 0x02) {
                logInfo("DfuSe protocol detected. Parsing memory sectors...");
                dfuDevice = new dfuse.Device(selected_device.device_, selected_device.settings);
                dfuDevice.properties = desc;
                
                if (dfuDevice.memoryInfo) {
                    let totalSize = 0;
                    for (let segment of dfuDevice.memoryInfo.segments) {
                        totalSize += segment.end - segment.start;
                    }
                    memorySummary = `Memory: ${dfuDevice.memoryInfo.name} (${Math.round(totalSize/1024)} KiB)`;
                    let firstWritable = dfuDevice.getFirstWritableSegment();
                    if (firstWritable) {
                        dfuDevice.startAddress = firstWritable.start;
                        document.querySelector("#dfu-start-addr").value = "0x" + firstWritable.start.toString(16);
                        logInfo(`Default DfuSe write segment: ${hex32(firstWritable.start)}`);
                    }
                }
            } else {
                dfuDevice = selected_device;
            }
        } else {
            dfuDevice = selected_device;
        }
        
        // Hook up log methods
        dfuDevice.logDebug = logDebug;
        dfuDevice.logInfo = logInfo;
        dfuDevice.logWarning = logWarning;
        dfuDevice.logError = logError;
        dfuDevice.logProgress = logProgress;
        
        document.querySelector("#dfu-status").textContent = "Connected";
        document.querySelector("#dfu-status").className = "status-connected";
        if (btn) {
            btn.textContent = "Disconnect";
            btn.disabled = false;
        }
        
        document.querySelector("#dfu-device-info").textContent = 
            `Device: ${dfuDevice.device_.productName || "Unknown"}\n` +
            `Manufacturer: ${dfuDevice.device_.manufacturerName || "Unknown"}\n` +
            `Serial: ${dfuDevice.device_.serialNumber || "Unknown"}\n` +
            (memorySummary ? `${memorySummary}\n` : "");
            
        enableDFUControls(true);
        const firmwareSelect = document.querySelector("#firmware-select");
        if (firmwareSelect && firmwareSelect.value !== "custom") {
            await loadServerFirmware(firmwareSelect.value);
        }
        logSuccess("DFU Interface opened successfully.");
    } catch (err) {
        logError(`DFU Connection failed: ${err.message}`);
        disconnectDFU();
        if (btn) {
            btn.textContent = "Connect Flasher (DFU)";
            btn.disabled = false;
        }
    }
}

function disconnectDFU() {
    if (dfuDevice) {
        const btn = document.querySelector("#btn-connect-dfu");
        if (btn) btn.disabled = true;
        dfuDevice.close().then(() => {
            logInfo("DFU interface closed.");
            dfuDevice = null;
            document.querySelector("#dfu-status").textContent = "Disconnected";
            document.querySelector("#dfu-status").className = "status-disconnected";
            if (btn) {
                btn.textContent = "Connect Flasher (DFU)";
                btn.disabled = false;
            }
            document.querySelector("#dfu-device-info").textContent = "";
            enableDFUControls(false);
        }).catch(err => {
            logError(`Error closing DFU: ${err.message}`);
            if (btn) btn.disabled = false;
        });
    }
}

function enableDFUControls(enable) {
    const controls = document.querySelectorAll("#dfu-panel input, #dfu-panel select, #dfu-panel button:not(#btn-connect-dfu)");
    controls.forEach(el => el.disabled = !enable);
    
    // Also manage the drop zone visibility and input disabled state based on selection
    const firmwareSelect = document.querySelector("#firmware-select");
    const dropZone = document.querySelector("#drop-zone");
    const fileInput = document.querySelector("#dfu-file-input");
    if (enable && firmwareSelect && firmwareSelect.value === "custom") {
        dropZone.hidden = false;
        if (fileInput) fileInput.disabled = false;
        dropZone.classList.remove("disabled");
    } else {
        dropZone.hidden = true;
        if (fileInput) fileInput.disabled = true;
        dropZone.classList.add("disabled");
    }
}

async function startDownload() {
    if (!dfuDevice) {
        logError("DFU Device not connected.");
        return;
    }
    if (!firmwareFile) {
        logError("No firmware file selected.");
        return;
    }
    
    const connectBtn = document.querySelector("#btn-connect-dfu");
    if (connectBtn) connectBtn.disabled = true;
    enableDFUControls(false);
    
    try {
        logInfo("Preparing device status...");
        let status = await dfuDevice.getStatus();
        if (status.state === dfu.dfuERROR) {
            await dfuDevice.clearStatus();
        }
        
        logInfo("Writing firmware to device...");
        const progressEl = document.querySelector("#dfu-progress");
        if (progressEl) progressEl.value = 0;
        
        const startTime = performance.now();
        await dfuDevice.do_download(dfuTransferSize, firmwareFile, dfuManifestationTolerant);
        const duration = ((performance.now() - startTime) / 1000).toFixed(1);
        
        logSuccess(`Flashing completed successfully in ${duration} seconds.`);
        
        // Wait for disconnect or reset
        if (!dfuManifestationTolerant) {
            logInfo("Waiting for device reset...");
            try {
                await dfuDevice.waitDisconnected(5000);
                logSuccess("Device disconnected and rebooted.");
                disconnectDFU();
            } catch (err) {
                logWarning("Timeout waiting for device disconnect.");
            }
        }
    } catch (err) {
        logError(`Error during download: ${err}`);
    } finally {
        if (connectBtn) connectBtn.disabled = false;
        enableDFUControls(true);
    }
}

async function startUpload() {
    if (!dfuDevice) {
        logError("DFU Device not connected.");
        return;
    }
    
    const connectBtn = document.querySelector("#btn-connect-dfu");
    if (connectBtn) connectBtn.disabled = true;
    enableDFUControls(false);
    
    try {
        const sizeField = document.querySelector("#dfu-upload-size");
        const maxSize = parseInt(sizeField.value) || 1024 * 128; // Default 128KiB
        
        logInfo(`Reading ${maxSize} bytes from device...`);
        const progressEl = document.querySelector("#dfu-progress");
        if (progressEl) progressEl.value = 0;
        
        let status = await dfuDevice.getStatus();
        if (status.state === dfu.dfuERROR) {
            await dfuDevice.clearStatus();
        }
        
        const startTime = performance.now();
        const blob = await dfuDevice.do_upload(dfuTransferSize, maxSize);
        const duration = ((performance.now() - startTime) / 1000).toFixed(1);
        
        logSuccess(`Upload completed in ${duration} seconds.`);
        saveAs(blob, "aioc_firmware_backup.bin");
    } catch (err) {
        logError(`Error during upload: ${err}`);
    } finally {
        if (connectBtn) connectBtn.disabled = false;
        enableDFUControls(true);
    }
}

/* ==========================================================================
   Main Event Listeners & Bootstrapping
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
    // 1. Browser capability checks
    const webusbSupported = (typeof navigator.usb !== "undefined");
    const webhidSupported = (typeof navigator.hid !== "undefined");
    
    if (!webusbSupported || !webhidSupported) {
        const warningBanner = document.querySelector("#browser-warning");
        if (warningBanner) {
            warningBanner.hidden = false;
            let missing = [];
            if (!webusbSupported) missing.push("WebUSB");
            if (!webhidSupported) missing.push("WebHID");
            warningBanner.textContent = `Your browser does not support: ${missing.join(" & ")}. Please use Google Chrome, Edge, or another Chromium-based browser.`;
        }
        logError("WebUSB/WebHID not supported in this browser. Flashing and configuration features will be unavailable.");
        document.querySelector("#btn-connect-hid").disabled = true;
        document.querySelector("#btn-connect-dfu").disabled = true;
    } else {
        logInfo("WebUSB and WebHID interfaces loaded. Browser is compatible.");
    }
    
    // 2. Tab switching logic
    const tabs = document.querySelectorAll(".tab-btn");
    const panels = document.querySelectorAll(".panel");
    
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            panels.forEach(p => p.classList.remove("active"));
            
            tab.classList.add("active");
            document.querySelector(`#${tab.dataset.tab}`).classList.add("active");
            logDebug(`Switched to tab: ${tab.dataset.tab}`);
        });
    });
    
    // 3. WebHID configuration buttons
    document.querySelector("#btn-connect-hid").addEventListener("click", () => {
        if (hidDevice) {
            disconnectHID();
        } else {
            connectHID();
        }
    });
    
    document.querySelector("#btn-read-settings").addEventListener("click", readAllSettings);
    document.querySelector("#btn-write-settings").addEventListener("click", () => writeAllSettings(false));
    document.querySelector("#btn-save-settings").addEventListener("click", () => writeAllSettings(true));
    document.querySelector("#btn-load-defaults").addEventListener("click", loadDefaults);
    document.querySelector("#btn-reboot-hid").addEventListener("click", rebootDevice);
    
    // PTT Preset Helpers
    document.querySelector("#preset-chirp").addEventListener("click", () => {
        // CHIRP typically uses Serial RTS/DTR
        document.querySelectorAll("input[id^='ptt1-']").forEach(el => el.checked = false);
        document.querySelector("#ptt1-serialrts").checked = true;
        document.querySelector("#ptt1-serialdtr").checked = true;
        logInfo("Applied PTT1 preset: CHIRP Programming (RTS & DTR)");
    });
    
    document.querySelector("#preset-soundcard").addEventListener("click", () => {
        // Soundcard modes typically trigger via CM108 GPIOs
        document.querySelectorAll("input[id^='ptt1-']").forEach(el => el.checked = false);
        document.querySelector("#ptt1-cm108gpio1").checked = true;
        logInfo("Applied PTT1 preset: Soundcard Digital Modes (CM108 GPIO 1)");
    });
    
    // 4. WebUSB DFU Flashing buttons
    document.querySelector("#btn-connect-dfu").addEventListener("click", () => {
        if (dfuDevice) {
            disconnectDFU();
        } else {
            connectDFU();
        }
    });
    
    // Handle DFU parameter changes
    document.querySelector("#dfu-xfer-size").addEventListener("change", (e) => {
        dfuTransferSize = parseInt(e.target.value) || 1024;
    });
    document.querySelector("#dfu-start-addr").addEventListener("change", (e) => {
        if (dfuDevice && !isNaN(parseInt(e.target.value, 16))) {
            dfuDevice.startAddress = parseInt(e.target.value, 16);
        }
    });
    
    // Handle File Drop / Select
    const fileInput = document.querySelector("#dfu-file-input");
    fileInput.addEventListener("change", (e) => {
        firmwareFile = null;
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            document.querySelector("#file-info").textContent = `Selected: ${file.name} (${niceSize(file.size)})`;
            
            const reader = new FileReader();
            reader.onload = () => {
                firmwareFile = reader.result;
                logInfo(`Firmware file loaded: ${file.name} (${file.size} bytes)`);
            };
            reader.readAsArrayBuffer(file);
        } else {
            document.querySelector("#file-info").textContent = "Drag & drop your firmware file or click to browse";
        }
    });
    
    document.querySelector("#btn-flash").addEventListener("click", startDownload);
    document.querySelector("#btn-upload").addEventListener("click", startUpload);
    
    // Handle Firmware selection changes
    const firmwareSelect = document.querySelector("#firmware-select");
    const dropZone = document.querySelector("#drop-zone");
    
    firmwareSelect.addEventListener("change", async () => {
        firmwareFile = null;
        if (firmwareSelect.value === "custom") {
            dropZone.hidden = false;
            if (fileInput) fileInput.disabled = false;
            dropZone.classList.remove("disabled");
            document.querySelector("#file-info").textContent = "Drag & drop your firmware file or click to browse";
        } else {
            dropZone.hidden = true;
            if (fileInput) fileInput.disabled = true;
            dropZone.classList.add("disabled");
            if (dfuDevice) {
                await loadServerFirmware(firmwareSelect.value);
            }
        }
    });

    // 5. Console clearing
    document.querySelector("#btn-clear-console").addEventListener("click", () => {
        document.querySelector("#terminal-output").innerHTML = "";
    });
    
    // Helper sizing function
    function niceSize(n) {
        if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
        if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
        return n + " B";
    }
    
    // WebUSB disconnect event
    navigator.usb?.addEventListener("disconnect", (event) => {
        if (dfuDevice && dfuDevice.device_ === event.device) {
            logWarning("DFU device disconnected unexpectedly.");
            disconnectDFU();
        }
    });
});
