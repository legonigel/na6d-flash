# NA6D Flash
NA6D's flasher for the [AIOC](https://github.com/skuep/AIOC)

This page is served at flash.na6d.com and acts as NA6D's site to help users of the AIOC flash their AIOCs and edit HID settings, similar to DFU util and [aioc-util](https://github.com/hrafnkelle/aioc-util)

## Open Source Attributions and Licenses

This repository integrates code from the following third-party projects:

* **[webdfu](https://github.com/devanlai/webdfu)** by Devan Lai: A WebUSB-based Device Firmware Upgrade (DFU) protocol implementation. Used for browser-based firmware uploading (`src/dfu.js`, `src/dfuse.js`). Licensed under the [ISC License](https://spdx.org/licenses/ISC.html) (included in the headers of the respective files).
* **[FileSaver.js](https://github.com/eligrey/FileSaver.js)** by Eli Grey: A client-side file-saving library. Used for downloading firmware backups (`src/FileSaver.js`). Licensed under the [MIT License](https://github.com/eligrey/FileSaver.js/blob/master/LICENSE.md) (included in the header of the file).

