'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PROFILES = 25;
const WINDOW_LAYOUTS = new Set(['minimized', 'tiled', 'last-used']);

function defaultSettings() {
  return {
    skipPassword: false,   // do not mirror values typed into password fields
    coordFallback: true,   // when an element can't be resolved, click by coordinates
    syncFullFieldValues: false, // avoid overwriting follower account-specific form values
    windowLayout: 'minimized',
  };
}

/**
 * Stores the list of app-managed Chrome profiles and app settings in a JSON
 * file under Electron's userData directory. Each profile owns a dedicated,
 * PERSISTENT Chrome user-data directory — created once, reused forever, so
 * logins/cookies survive across sessions. Deleting a profile wipes its dir.
 */
class ProfileStore {
  constructor(userDataPath) {
    this.root = userDataPath;
    this.profilesDir = path.join(userDataPath, 'profiles');
    this.configPath = path.join(userDataPath, 'mirror-config.json');
    fs.mkdirSync(this.profilesDir, { recursive: true });
    this.config = this._load();
    this._save();
  }

  _load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      c.profiles = Array.isArray(c.profiles) ? c.profiles : [];
      c.settings = Object.assign(defaultSettings(), c.settings || {});
      if (!('leaderId' in c)) c.leaderId = null;
      if (!Array.isArray(c.followerIds)) {
        c.followerIds = c.followerId ? [c.followerId] : [];
      }
      delete c.followerId;
      if (!WINDOW_LAYOUTS.has(c.settings.windowLayout)) c.settings.windowLayout = 'minimized';
      return c;
    } catch (_) {
      return { profiles: [], settings: defaultSettings(), leaderId: null, followerIds: [] };
    }
  }

  _save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  list() {
    return this.config.profiles;
  }

  get(id) {
    return this.config.profiles.find((p) => p.id === id) || null;
  }

  create(name) {
    if (this.config.profiles.length >= MAX_PROFILES) {
      throw new Error(`Chrome Mirror supports up to ${MAX_PROFILES} profiles.`);
    }
    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(this.profilesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const profile = {
      id,
      name: (name && name.trim()) || `Profile ${this.config.profiles.length + 1}`,
      dir,
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    this.config.profiles.push(profile);
    this._save();
    return profile;
  }

  rename(id, name) {
    const p = this.get(id);
    if (p && name && name.trim()) {
      p.name = name.trim();
      this._save();
    }
    return p;
  }

  remove(id) {
    const p = this.get(id);
    if (p) {
      try {
        fs.rmSync(p.dir, { recursive: true, force: true });
      } catch (_) {
        /* directory may be locked if Chrome is open; ignore */
      }
      this.config.profiles = this.config.profiles.filter((x) => x.id !== id);
      if (this.config.leaderId === id) this.config.leaderId = null;
      this.config.followerIds = this.config.followerIds.filter((x) => x !== id);
      this._save();
    }
    return { ok: true };
  }

  touch(id) {
    const p = this.get(id);
    if (p) {
      p.lastUsedAt = Date.now();
      this._save();
    }
  }

  getRoles() {
    return {
      leaderId: this.config.leaderId,
      followerIds: [...this.config.followerIds],
      windowLayout: this.config.settings.windowLayout,
    };
  }

  setRoles(leaderId, followerIds, windowLayout) {
    const knownIds = new Set(this.config.profiles.map((profile) => profile.id));
    this.config.leaderId = knownIds.has(leaderId) ? leaderId : null;
    this.config.followerIds = Array.from(new Set(Array.isArray(followerIds) ? followerIds : []))
      .filter((id) => knownIds.has(id) && id !== this.config.leaderId)
      .slice(0, MAX_PROFILES - 1);
    if (WINDOW_LAYOUTS.has(windowLayout)) this.config.settings.windowLayout = windowLayout;
    this._save();
    return this.getRoles();
  }

  getSettings() {
    return this.config.settings;
  }

  setSettings(patch) {
    this.config.settings = Object.assign({}, this.config.settings, patch || {});
    if (!WINDOW_LAYOUTS.has(this.config.settings.windowLayout)) {
      this.config.settings.windowLayout = 'minimized';
    }
    this._save();
    return this.config.settings;
  }
}

module.exports = { ProfileStore, defaultSettings, MAX_PROFILES, WINDOW_LAYOUTS };
