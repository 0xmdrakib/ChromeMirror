'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Safe, minimal bridge between the renderer UI and the main process.
contextBridge.exposeInMainWorld('api', {
  // profiles
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', name),
  renameProfile: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),

  // roles
  getRoles: () => ipcRenderer.invoke('roles:get'),
  setRoles: (leaderId, followerIds, windowLayout) =>
    ipcRenderer.invoke('roles:set', leaderId, followerIds, windowLayout),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // session
  getStatus: () => ipcRenderer.invoke('session:status'),
  startSession: () => ipcRenderer.invoke('session:start'),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  setMirror: (on) => ipcRenderer.invoke('mirror:set', on),
  focusProfile: (profileId) => ipcRenderer.invoke('session:focus-profile', profileId),
  retryFollower: (profileId) => ipcRenderer.invoke('session:retry-follower', profileId),
  setWindowLayout: (layout) => ipcRenderer.invoke('session:layout', layout),

  // license
  checkLicense: () => ipcRenderer.invoke('license:check'),
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  licenseStatus: () => ipcRenderer.invoke('license:status'),
  retryLicense: () => ipcRenderer.invoke('license:retry'),

  // push channels
  onStatus: (cb) => ipcRenderer.on('status', (_e, d) => cb(d)),
  onLog: (cb) => ipcRenderer.on('log', (_e, d) => cb(d)),
  onLicenseBlocked: (cb) => ipcRenderer.on('license:blocked', (_e, d) => cb(d)),
});
