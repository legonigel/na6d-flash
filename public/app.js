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
let originalDeviceVid = null;
let originalDevicePid = null;
let dfuDevice = null;
let firmwareFile = null;
let dfuManifestationTolerant = true;
let dfuTransferSize = 1024;
let expectingDisconnect = false;
let deviceDisconnectedDuringFlash = false;
let currentModule = "dfu"; // Tracks the active layout tab ("hid" or "dfu")

// Settings state status variables
let settingsModified = false;
let settingsAppliedTemporarily = false;
let currentFlashPhase = "";

function showSettingsStatus(state, msg) {
    const banner = document.querySelector("#settings-status-banner");
    if (!banner) return;
    if (!state) {
        banner.hidden = true;
        return;
    }
    banner.hidden = false;
    banner.className = `alert-box ${state}`;
    banner.innerHTML = msg;
}

// Helper sizing function (moved to file-level scope)
function niceSize(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
}

// Log helper
function log(type, msg, module = null) {
    const targetModule = module || currentModule;
    const time = new Date().toLocaleTimeString();
    
    // Detect download/erase/backup phase from logs
    if (msg.includes("Erasing DFU device memory") || msg.includes("Erasing DFU device")) {
        currentFlashPhase = "erase";
    } else if (msg.includes("Copying data") || msg.includes("Writing firmware")) {
        currentFlashPhase = "write";
    } else if (msg.includes("Reading")) {
        currentFlashPhase = "backup";
    }
    
    // Strip HTML tags for developer console logs
    const plainTextMsg = msg.replace(/<[^>]*>/g, "");
    const consoleMsg = `[${time}] [${targetModule.toUpperCase()}] ${plainTextMsg}`;
    
    if (type === "error") {
        console.error(consoleMsg);
    } else if (type === "warning") {
        console.warn(consoleMsg);
    } else if (type === "debug") {
        console.debug(consoleMsg);
    } else {
        console.log(consoleMsg);
    }

    // Skip showing debug logs in on-page alerts
    if (type === "debug") return;

    // Update on-page alert box
    const alertEl = document.querySelector(`#${targetModule}-alert`);
    if (alertEl) {
        alertEl.className = `alert-box ${type}`;
        alertEl.innerHTML = msg;
        alertEl.hidden = false;
    }
}

function logInfo(msg, module = null) { log("info", msg, module); }
function logWarning(msg, module = null) { log("warning", msg, module); }
function logError(msg, module = null) { log("error", msg, module); }
function logDebug(msg) {
    console.debug(`[DEBUG] ${msg}`);
}
function logSuccess(msg, module = null) { log("success", msg, module); }

function hideAlert(module) {
    const alertEl = document.querySelector(`#${module}-alert`);
    if (alertEl) {
        alertEl.hidden = true;
    }
}

// UI Progress logger interface for DFU
function logProgress(done, total) {
    const progressEl = document.querySelector("#dfu-progress");
    if (!progressEl) return;
    
    if (currentFlashPhase === "erase") {
        progressEl.value = 0;
        
        const alertEl = document.querySelector("#dfu-alert");
        if (alertEl && !alertEl.hidden) {
            alertEl.className = "alert-box info";
            const pct = total ? Math.round((done / total) * 100) : 0;
            alertEl.innerHTML = `<p>Erasing device memory... <strong>${pct}%</strong></p>`;
        }
        return;
    }
    
    if (typeof total === "undefined") {
        progressEl.removeAttribute("value");
        logDebug(`Progress: ${done} bytes`);
        
        const alertEl = document.querySelector("#dfu-alert");
        if (alertEl && !alertEl.hidden) {
            alertEl.className = "alert-box info";
            alertEl.innerHTML = `<p>Operation in progress... (Processed <strong>${niceSize(done)}</strong>)</p>`;
        }
    } else {
        progressEl.max = total;
        progressEl.value = done;
        const pct = Math.round((done / total) * 100);
        logDebug(`Progress: ${done}/${total} bytes (${pct}%)`);
        
        const alertEl = document.querySelector("#dfu-alert");
        if (alertEl && !alertEl.hidden) {
            alertEl.className = "alert-box info";
            let actionText = currentFlashPhase === "backup" ? "Reading from AIOC..." : "Writing to AIOC...";
            alertEl.innerHTML = `<p>${actionText} <strong>${pct}%</strong> (${niceSize(done)} of ${niceSize(total)})</p>`;
        }
    }
}

// Helper: formats hex numbers nicely
function hex16(n) {
    return "0x" + n.toString(16).padStart(4, "0").toUpperCase();
}
function hex32(n) {
    return "0x" + n.toString(16).padStart(8, "0").toUpperCase();
}

// Helper: Wraps a promise with a timeout
function withTimeout(promise, ms, timeoutError) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(timeoutError));
        }, ms);
        
        promise.then(
            (res) => {
                clearTimeout(timer);
                resolve(res);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
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
    
    // WebHID may omit the report ID byte for Report ID 0 depending on the platform/OS:
    // - 6-byte response: [cmd, addr, v0, v1, v2, v3] -> value starts at offset 2
    // - 7-byte response: [reportId, cmd, addr, v0, v1, v2, v3] -> value starts at offset 3
    if (response.byteLength < 6) {
        throw new Error(`Short feature report received: ${response.byteLength} bytes`);
    }
    const offset = response.byteLength >= 7 ? 3 : 2;
    return response.getUint32(offset, true);
}

async function writeRegister(device, address, value) {
    await sendHIDFeature(device, Command.WRITESTROBE, address, value);
}

async function connectHID() {
    disconnectDFU(); // Prevent concurrent USB access
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
            const warningHtml = `
                <strong>Connection failed: Selected interface does not support configuration.</strong>
                <p style="margin-top: 0.5rem;">To resolve this:</p>
                <ul>
                    <li>If your device is running firmware v1.3.0 or later, make sure to select the <strong>"AIOC HID"</strong> interface in the browser prompt (not "CM108").</li>
                    <li>If "AIOC HID" is not visible or you are on firmware v1.2.0 or older, please upgrade your AIOC firmware to v1.3.0+ using the <strong>Update Firmware</strong> tab.</li>
                </ul>
            `;
            log("error", warningHtml, "hid");
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
            btn.textContent = "Connect AIOC Settings";
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
            originalDeviceVid = null;
            originalDevicePid = null;
            document.querySelector("#hid-status").textContent = "Disconnected";
            document.querySelector("#hid-status").className = "status-disconnected";
            if (btn) {
                btn.textContent = "Connect AIOC Settings";
                btn.disabled = false;
            }
            enableHIDControls(false);
            clearHIDFields();
            showSettingsStatus(null);
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
        
        // Clear active presets class on read
        document.querySelectorAll(".btn-preset").forEach(btn => btn.classList.remove("active"));
        
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
        
        // USB ID Override (0x08)
        const usbidVal = await readRegister(hidDevice, Register.USBID);
        const vid = usbidVal & 0xFFFF;
        const pid = (usbidVal >> 16) & 0xFFFF;
        document.querySelector("#usb-vid").value = hex16(vid);
        document.querySelector("#usb-pid").value = hex16(pid);
        logInfo(`USB VID/PID: ${hex16(vid)}:${hex16(pid)}`);
        
        // Save initial values
        originalDeviceVid = vid;
        originalDevicePid = pid;
        
        logSuccess("Registers loaded successfully.");
        showSettingsStatus(null);
        settingsModified = false;
        settingsAppliedTemporarily = false;
        checkMatchingPreset();
    } catch (err) {
        logError(`Failed reading registers: ${err.message}`);
    }
}

function checkMatchingPreset() {
    // Clear all active presets first
    document.querySelectorAll(".btn-preset").forEach(btn => btn.classList.remove("active"));
    
    const ptt1Val = collectPTTValue("ptt1");
    const ptt2Val = collectPTTValue("ptt2");
    const rxGain = parseInt(document.querySelector("#audio-rx-gain").value);
    const txBoost = document.querySelector("#audio-tx-boost").checked;
    const vcosLvl = parseInt(document.querySelector("#vcos-level").value) || 0;
    const vcosTim = parseInt(document.querySelector("#vcos-timeout").value) || 0;
    const vpttLvl = parseInt(document.querySelector("#vptt-level").value) || 0;
    const vpttTim = parseInt(document.querySelector("#vptt-timeout").value) || 0;
    const vidVal = document.querySelector("#usb-vid").value.trim().toLowerCase();
    const pidVal = document.querySelector("#usb-pid").value.trim().toLowerCase();

    // Standardize hex strings (e.g. 0x1209 vs 1209)
    const normalizeHex = (str) => {
        if (!str) return "";
        if (str.startsWith("0x")) return str;
        return "0x" + str;
    };
    const vid = normalizeHex(vidVal);
    const pid = normalizeHex(pidVal);

    // 1. Default Config preset
    const isDefault = (
        ptt1Val === (PTTSource.CM108GPIO3 | PTTSource.SERIALDTRNRTS) &&
        ptt2Val === PTTSource.CM108GPIO4 &&
        rxGain === 0 && !txBoost &&
        vcosLvl === 256 && vcosTim === 3200 &&
        vpttLvl === 16 && vpttTim === 320 &&
        vid === "0x1209" && pid === "0x7388"
    );
    if (isDefault) {
        document.querySelector("#preset-defaults")?.classList.add("active");
        return;
    }

    // 2. CHIRP Programming preset
    const isChirp = (
        ptt1Val === (PTTSource.SERIALRTS | PTTSource.SERIALDTR) &&
        ptt2Val === 0 &&
        rxGain === 0 && !txBoost &&
        vcosLvl === 256 && vcosTim === 3200 &&
        vpttLvl === 16 && vpttTim === 320 &&
        vid === "0x1209" && pid === "0x7388"
    );
    if (isChirp) {
        document.querySelector("#preset-chirp")?.classList.add("active");
        return;
    }

    // 3. Digital Modes preset
    const isSoundcard = (
        ptt1Val === PTTSource.CM108GPIO1 &&
        ptt2Val === 0 &&
        rxGain === 0 && !txBoost &&
        vcosLvl === 256 && vcosTim === 3200 &&
        vpttLvl === 16 && vpttTim === 320 &&
        vid === "0x1209" && pid === "0x7388"
    );
    if (isSoundcard) {
        document.querySelector("#preset-soundcard")?.classList.add("active");
        return;
    }

    // 4. AllStarLink preset
    const isASL = (
        ptt1Val === PTTSource.CM108GPIO1 &&
        ptt2Val === 0 &&
        rxGain === 0 && !txBoost &&
        vcosLvl === 256 && vcosTim === 1500 &&
        vpttLvl === 16 && vpttTim === 320 &&
        vid === "0x0d8c" && pid === "0x000c"
    );
    if (isASL) {
        document.querySelector("#preset-asl")?.classList.add("active");
        return;
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
    
    // Check if USB ID has been modified from original value read from device
    const vidStr = document.querySelector("#usb-vid").value.trim();
    const pidStr = document.querySelector("#usb-pid").value.trim();
    const vid = parseInt(vidStr.startsWith("0x") || vidStr.startsWith("0X") ? vidStr : "0x" + vidStr, 16);
    const pid = parseInt(pidStr.startsWith("0x") || pidStr.startsWith("0X") ? pidStr : "0x" + pidStr, 16);
    
    if (originalDeviceVid !== null && originalDevicePid !== null && !isNaN(vid) && !isNaN(pid)) {
        if (vid !== originalDeviceVid || pid !== originalDevicePid) {
            const confirmed = confirm(
                `⚠️ WARNING: You are changing the USB Vendor ID (VID) / Product ID (PID) from the values currently read on the device.\n\n` +
                `Current: ${hex16(originalDeviceVid)}:${hex16(originalDevicePid)}\n` +
                `New: ${hex16(vid)}:${hex16(pid)}\n\n` +
                `This will change how your operating system and browser recognize the device when it reboots. If this is incorrect, the AIOC may become unrecognized.\n\n` +
                `Are you sure you want to proceed with this change?`
            );
            if (!confirmed) {
                logWarning("USB ID override change cancelled by user. Settings not applied.");
                return;
            }
        }
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
        
        // USB ID Override
        const vidStr = document.querySelector("#usb-vid").value.trim();
        const pidStr = document.querySelector("#usb-pid").value.trim();
        const vid = parseInt(vidStr.startsWith("0x") || vidStr.startsWith("0X") ? vidStr : "0x" + vidStr, 16);
        const pid = parseInt(pidStr.startsWith("0x") || pidStr.startsWith("0X") ? pidStr : "0x" + pidStr, 16);
        if (!isNaN(vid) && !isNaN(pid)) {
            const usbidVal = ((pid & 0xFFFF) << 16) | (vid & 0xFFFF);
            await writeRegister(hidDevice, Register.USBID, usbidVal);
        }
        
        logSuccess("Settings written to device RAM successfully.");
        
        if (store) {
            logInfo("Saving settings to persistent Flash memory...");
            await sendHIDFeature(hidDevice, Command.STORE, 0, 0);
            logSuccess("Settings permanently saved.");
            
            settingsModified = false;
            settingsAppliedTemporarily = false;
            showSettingsStatus("success", "<strong>✅ Permanently Saved:</strong> Settings are written to persistent flash memory and will survive unplugging/rebooting.");
        } else {
            settingsModified = false;
            settingsAppliedTemporarily = true;
            showSettingsStatus("info", "<strong>ℹ️ Temporarily Applied:</strong> Changes are active but will reset if the AIOC is unplugged. Click <em>Save Permanently to AIOC</em> to write them permanently.");
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
        showSettingsStatus("info", "<strong>ℹ️ Defaults Loaded:</strong> Factory defaults applied to form. Click <em>Save Permanently to AIOC</em> to write them permanently.");
        settingsModified = true;
        settingsAppliedTemporarily = false;
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
        document.querySelector("#step-write")?.classList.remove("inactive");
    } catch (err) {
        logError(`Failed to load firmware from server: ${err.message}`);
        firmwareFile = null;
        document.querySelector("#step-write")?.classList.add("inactive");
    }
}

async function trySoftwareRebootToDFU() {
    try {
        logInfo("Checking if AIOC is connected in normal configuration mode...");
        
        // Check if we already have an active HID connection
        if (hidDevice && hidDevice.opened) {
            logInfo("Active configuration connection found. Sending reboot command...");
            await sendHIDFeature(hidDevice, Command.REBOOT, 0, 0);
            logSuccess("Reboot command sent. Waiting for DFU bootloader...");
            disconnectHID();
            await new Promise(resolve => setTimeout(resolve, 2500));
            return true;
        }
        
        const hid_devices = await navigator.hid.getDevices();
        const aioc_hid = hid_devices.find(d => d.vendorId === 0x1209 && d.productId === 0x7388);
        
        if (aioc_hid) {
            logInfo("Found paired AIOC in configuration mode. Attempting automatic reboot to DFU bootloader...");
            if (!aioc_hid.opened) {
                await aioc_hid.open();
            }
            await sendHIDFeature(aioc_hid, Command.REBOOT, 0, 0);
            logSuccess("Reboot command sent to AIOC. Waiting for DFU bootloader to enumerate...");
            await aioc_hid.close();
            
            await new Promise(resolve => setTimeout(resolve, 2500));
            return true;
        }
    } catch (err) {
        logWarning(`Software reboot attempt failed: ${err.message}`);
    }
    return false;
}

async function connectDFU() {
    disconnectHID(); // Prevent concurrent USB access conflicts
    const btn = document.querySelector("#btn-connect-dfu");
    if (btn) btn.disabled = true;
    try {
        logInfo("Scanning for USB DFU interfaces...");
        let dfu_devices = await dfu.findAllDfuInterfaces();
        
        // Filter to match DFU bootloader (0483:df11) AND normal-mode AIOC DFU runtime interface (1209:7388)
        dfu_devices = dfu_devices.filter(d => 
            (d.device_.vendorId === 0x0483 && d.device_.productId === 0xDF11) ||
            (d.device_.vendorId === 0x1209 && d.device_.productId === 0x7388)
        );
        
        if (dfu_devices.length === 0) {
            const rebooted = await trySoftwareRebootToDFU();
            if (rebooted) {
                logInfo("Scanning again for DFU bootloader...");
                dfu_devices = await dfu.findAllDfuInterfaces();
                dfu_devices = dfu_devices.filter(d => 
                    (d.device_.vendorId === 0x0483 && d.device_.productId === 0xDF11) ||
                    (d.device_.vendorId === 0x1209 && d.device_.productId === 0x7388)
                );
            }
        }
        
        let selected_device = null;
        if (dfu_devices.length === 0) {
            logInfo("No active DFU device found. Requesting USB DFU device from user...");
            const rawUsbDevice = await navigator.usb.requestDevice({
                filters: [
                    { vendorId: 0x0483, productId: 0xDF11 },
                    { vendorId: 0x1209, productId: 0x7388 }
                ]
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
        
        logInfo("Opening DFU device...", "dfu");
        try {
            await withTimeout(selected_device.open(), 2500, "Timeout opening USB device. This usually means Windows is missing the WinUSB driver for the DFU interface.");
        } catch (error) {
            if (error.message.includes("Timeout opening USB device")) {
                let warningHtml = "";
                if (selected_device.device_.vendorId === 0x1209) {
                    warningHtml = `
                        <strong>Windows Driver Issue Detected</strong>
                        <p>Your AIOC is in normal mode, but the browser is blocked trying to access its firmware update interface (Interface 6).</p>
                        <p style="margin-top: 0.5rem;"><strong>To fix this:</strong></p>
                        <ul>
                            <li>Open <a href="https://zadig.akeo.ie" target="_blank" rel="noopener">Zadig</a>, select <em>Options > List All Devices</em>, select <strong>All-In-One-Cable (Interface 6)</strong>, and install/replace the driver with <strong>WinUSB</strong>.</li>
                            <li><strong>Alternative:</strong> Bypass the normal-mode driver block by manually entering update mode: unplug the USB cable, short the two hardware DFU pins on the board, and plug the USB cable back in.</li>
                        </ul>
                    `;
                } else {
                    warningHtml = `
                        <strong>Windows Driver Issue Detected</strong>
                        <p>Your AIOC is in firmware update mode, but Windows does not have the WinUSB driver installed for it.</p>
                        <p style="margin-top: 0.5rem;"><strong>To fix this:</strong></p>
                        <ul>
                            <li>Open <a href="https://zadig.akeo.ie" target="_blank" rel="noopener">Zadig</a>, select <em>Options > List All Devices</em>, select <strong>STM32 BOOTLOADER</strong>, and install/replace driver with <strong>WinUSB</strong>.</li>
                        </ul>
                    `;
                }
                log("error", warningHtml, "dfu");
            } else {
                logError(`DFU Connection failed: ${error.message}`, "dfu");
            }
            throw error;
        }
        
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
        
        // Check if device is in Runtime mode (0x01) or DFU mode (0x02)
        const isRuntimeMode = selected_device.settings.alternate.interfaceProtocol === 0x01;
        
        // Hook up log methods
        dfuDevice.logDebug = logDebug;
        dfuDevice.logInfo = logInfo;
        dfuDevice.logWarning = logWarning;
        dfuDevice.logError = logError;
        dfuDevice.logProgress = logProgress;
        
        if (isRuntimeMode) {
            logWarning("Device is connected in normal mode. Automatically restarting AIOC into firmware update mode...");
            await dfuDevice.detach();
            logSuccess("Detach command sent successfully. Rebooting...");
            
            // Close interface
            await dfuDevice.close();
            logInfo("DFU runtime interface closed.");
            
            // Wait for disconnect
            try {
                await dfuDevice.waitDisconnected(5000);
                logSuccess("Device disconnected.");
            } catch (err) {
                logWarning("Timeout waiting for disconnect.");
            }
            
            dfuDevice = null;
            
            // Wait 2.5 seconds for reboot and USB enumeration
            logInfo("Waiting for DFU bootloader to enumerate...");
            await new Promise(resolve => setTimeout(resolve, 2500));
            
            // Re-trigger connection!
            if (btn) btn.disabled = false;
            await connectDFU();
            return;
        }
        
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
            `Mode: DFU (Flashing Mode)\n` +
            (memorySummary ? `${memorySummary}\n` : "");
            
        enableDFUControls(true);
        document.querySelector("#step-select")?.classList.remove("inactive");
        const firmwareSelect = document.querySelector("#firmware-select");
        if (firmwareSelect && firmwareSelect.value !== "custom") {
            await loadServerFirmware(firmwareSelect.value);
        }
        logSuccess("DFU Interface opened successfully.");
    } catch (err) {
        if (!err.message.includes("Timeout opening USB device")) {
            logError(`DFU Connection failed: ${err.message}`);
        }
        disconnectDFU();
        if (btn) {
            btn.textContent = "Connect AIOC for Update";
            btn.disabled = false;
        }
    }
}

function disconnectDFU() {
    const btn = document.querySelector("#btn-connect-dfu");
    if (btn) btn.disabled = true;
    
    const cleanupUI = () => {
        document.querySelector("#dfu-status").textContent = "Disconnected";
        document.querySelector("#dfu-status").className = "status-disconnected";
        if (btn) {
            btn.textContent = "Connect AIOC for Update";
            btn.disabled = false;
        }
        document.querySelector("#dfu-device-info").textContent = "";
        enableDFUControls(false);
        document.querySelector("#step-select")?.classList.add("inactive");
        document.querySelector("#step-write")?.classList.add("inactive");
        expectingDisconnect = false;
        deviceDisconnectedDuringFlash = false;
    };

    if (dfuDevice) {
        dfuDevice.close().then(() => {
            logInfo("DFU interface closed.");
            dfuDevice = null;
            cleanupUI();
        }).catch(err => {
            logError(`Error closing DFU: ${err.message}`);
            dfuDevice = null;
            cleanupUI();
        });
    } else {
        dfuDevice = null;
        cleanupUI();
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
        expectingDisconnect = true;
        deviceDisconnectedDuringFlash = false;
        await dfuDevice.do_download(dfuTransferSize, firmwareFile, dfuManifestationTolerant);
        const duration = ((performance.now() - startTime) / 1000).toFixed(1);
        
        logSuccess(`Flashing completed successfully in ${duration} seconds.`);
        
        // Wait for disconnect or reset
        if (!dfuManifestationTolerant) {
            logInfo("Waiting for device reset...");
            try {
                if (deviceDisconnectedDuringFlash) {
                    logSuccess("Device disconnected and rebooted.");
                    disconnectDFU();
                } else if (dfuDevice) {
                    await dfuDevice.waitDisconnected(5000);
                    logSuccess("Device disconnected and rebooted.");
                    disconnectDFU();
                } else {
                    logSuccess("Device disconnected and rebooted.");
                    disconnectDFU();
                }
            } catch (err) {
                logWarning("Timeout waiting for device disconnect.");
            }
        }
    } catch (err) {
        logError(`Error during download: ${err}`);
    } finally {
        expectingDisconnect = false;
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
        console.log("[DFU] WebUSB and WebHID interfaces loaded. Browser is compatible.");
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
            currentModule = tab.dataset.tab === "hid-panel" ? "hid" : "dfu";
            logDebug(`Switched to tab: ${tab.dataset.tab}`);
        });
    });
    
    // 3. WebHID configuration buttons
    document.querySelector("#btn-connect-hid").addEventListener("click", () => {
        if (hidDevice) {
            disconnectHID();
            hideAlert("hid");
        } else {
            connectHID();
        }
    });
    
    document.querySelector("#btn-read-settings").addEventListener("click", readAllSettings);
    document.querySelector("#btn-write-settings").addEventListener("click", () => writeAllSettings(false));
    document.querySelector("#btn-save-settings").addEventListener("click", () => writeAllSettings(true));
    document.querySelector("#btn-load-defaults").addEventListener("click", loadDefaults);
    document.querySelector("#btn-reboot-hid").addEventListener("click", rebootDevice);
    
    // Device Presets & Configuration View Helpers
    function setActivePreset(buttonId) {
        document.querySelectorAll(".btn-preset").forEach(btn => {
            btn.classList.remove("active");
        });
        if (buttonId) {
            const el = document.querySelector(buttonId);
            if (el) el.classList.add("active");
        }
    }

    function setConfigDetailsOpen(open) {
        document.querySelectorAll("#hid-panel details").forEach(el => {
            el.open = open;
        });
    }

    function clearActivePresets() {
        document.querySelectorAll(".btn-preset").forEach(btn => {
            btn.classList.remove("active");
        });
    }

    function applyBaseDefaults() {
        // Clear all checkboxes
        document.querySelectorAll("input[id^='ptt1-'], input[id^='ptt2-']").forEach(el => el.checked = false);
        // Reset inputs to clean system defaults
        document.querySelector("#audio-rx-gain").value = "0";
        document.querySelector("#audio-tx-boost").checked = false;
        document.querySelector("#vcos-level").value = "256";
        document.querySelector("#vcos-timeout").value = "3200";
        document.querySelector("#vptt-level").value = "16";
        document.querySelector("#vptt-timeout").value = "320";
        document.querySelector("#fox-volume").value = "32768";
        document.querySelector("#fox-wpm").value = "20";
        document.querySelector("#fox-interval").value = "0";
        document.querySelector("#fox-message").value = "";
        document.querySelector("#usb-vid").value = "0x1209";
        document.querySelector("#usb-pid").value = "0x7388";
    }

    // Register presets event listeners
    document.querySelector("#preset-defaults").addEventListener("click", () => {
        applyBaseDefaults();
        document.querySelector("#ptt1-cm108gpio3").checked = true;
        document.querySelector("#ptt1-serialdtrnrts").checked = true;
        document.querySelector("#ptt2-cm108gpio4").checked = true;
        
        setConfigDetailsOpen(false);
        setActivePreset("#preset-defaults");
        logInfo("Applied preset: Default HID Configuration");
        
        settingsModified = true;
        settingsAppliedTemporarily = false;
        showSettingsStatus("warning", "<strong>⚠️ Unsaved changes:</strong> Preset loaded. Click <em>Apply Temporarily</em> or <em>Save Permanently</em> below to send these settings to the AIOC.");
    });

    document.querySelector("#preset-chirp").addEventListener("click", () => {
        applyBaseDefaults();
        // CHIRP typically uses Serial RTS/DTR
        document.querySelector("#ptt1-serialrts").checked = true;
        document.querySelector("#ptt1-serialdtr").checked = true;
        
        setConfigDetailsOpen(false);
        setActivePreset("#preset-chirp");
        logInfo("Applied preset: CHIRP Programming (RTS & DTR)");
        
        settingsModified = true;
        settingsAppliedTemporarily = false;
        showSettingsStatus("warning", "<strong>⚠️ Unsaved changes:</strong> Preset loaded. Click <em>Apply Temporarily</em> or <em>Save Permanently</em> below to send these settings to the AIOC.");
    });
    
    document.querySelector("#preset-soundcard").addEventListener("click", () => {
        applyBaseDefaults();
        // Soundcard modes typically trigger via CM108 GPIO 1
        document.querySelector("#ptt1-cm108gpio1").checked = true;
        
        setConfigDetailsOpen(false);
        setActivePreset("#preset-soundcard");
        logInfo("Applied preset: Soundcard Digital Modes (CM108 GPIO 1)");
        
        settingsModified = true;
        settingsAppliedTemporarily = false;
        showSettingsStatus("warning", "<strong>⚠️ Unsaved changes:</strong> Preset loaded. Click <em>Apply Temporarily</em> or <em>Save Permanently</em> below to send these settings to the AIOC.");
    });

    document.querySelector("#preset-asl").addEventListener("click", () => {
        applyBaseDefaults();
        // AllStarLink (CM108 Emulation) preset
        document.querySelector("#ptt1-cm108gpio1").checked = true;
        document.querySelector("#vcos-timeout").value = "1500";
        document.querySelector("#usb-vid").value = "0x0D8C";
        document.querySelector("#usb-pid").value = "0x000C";
        
        setConfigDetailsOpen(false);
        setActivePreset("#preset-asl");
        logInfo("Applied preset: AllStarLink (CM108 Emulation)");
        
        settingsModified = true;
        settingsAppliedTemporarily = false;
        showSettingsStatus("warning", "<strong>⚠️ Unsaved changes:</strong> Preset loaded. Click <em>Apply Temporarily</em> or <em>Save Permanently</em> below to send these settings to the AIOC.");
    });

    document.querySelector("#preset-custom").addEventListener("click", () => {
        setConfigDetailsOpen(true);
        setActivePreset("#preset-custom");
        logInfo("Custom Mode: Expanded all configuration sections.");
    });

    // Clear active presets on any manual config changes
    document.querySelectorAll("#hid-panel input, #hid-panel select").forEach(input => {
        const markDirty = () => {
            clearActivePresets();
            if (!settingsModified) {
                settingsModified = true;
                settingsAppliedTemporarily = false;
                showSettingsStatus("warning", "<strong>⚠️ Unsaved changes:</strong> You have edited settings on this page that are not yet sent to the AIOC. Click <em>Apply Temporarily</em> or <em>Save Permanently</em> below.");
            }
        };
        input.addEventListener("input", markDirty);
        input.addEventListener("change", markDirty);
    });

    // Morse code message input sanitization and auto-uppercase
    const foxMsgInput = document.querySelector("#fox-message");
    if (foxMsgInput) {
        foxMsgInput.addEventListener("input", (e) => {
            let val = e.target.value.toUpperCase();
            // Retain letters, digits, spaces, slashes, periods, and dashes
            val = val.replace(/[^A-Z0-9\s/.-]/g, "");
            if (e.target.value !== val) {
                e.target.value = val;
            }
        });
    }
    
    // 4. WebUSB DFU Flashing buttons
    document.querySelector("#btn-connect-dfu").addEventListener("click", () => {
        if (dfuDevice) {
            disconnectDFU();
            hideAlert("dfu");
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
        document.querySelector("#step-write")?.classList.add("inactive");
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            document.querySelector("#file-info").textContent = `Selected: ${file.name} (${niceSize(file.size)})`;
            
            const reader = new FileReader();
            reader.onload = () => {
                firmwareFile = reader.result;
                logInfo(`Firmware file loaded: ${file.name} (${file.size} bytes)`);
                document.querySelector("#step-write")?.classList.remove("inactive");
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
        document.querySelector("#step-write")?.classList.add("inactive");
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

    // 5. Console clearing (Removed since event log console panel was removed)
    
    // WebUSB disconnect event
    navigator.usb?.addEventListener("disconnect", (event) => {
        if (dfuDevice) {
            const isMatch = dfuDevice.device_ === event.device || (
                dfuDevice.device_.vendorId === event.device.vendorId &&
                dfuDevice.device_.productId === event.device.productId &&
                dfuDevice.device_.serialNumber === event.device.serialNumber
            );
            if (isMatch) {
                if (expectingDisconnect) {
                    deviceDisconnectedDuringFlash = true;
                } else {
                    logWarning("DFU device disconnected unexpectedly.");
                    disconnectDFU();
                }
            }
        }
    });
});
