// electron/preload.js
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getInfo: () => ({
    platform: process.platform,
    arch: process.arch,
  }),
});
