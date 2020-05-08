import * as lang from '../lib/language';
import * as prof from '../lib/profiles';
import { getTimezones } from '../lib/tz';

import util from './util';
import webext from './webext';
import { Interceptor } from './intercept';
import { v4 as uuidv4 } from 'uuid';

enum IntervalOption {
  None = 0,
  Custom = -1,
}

enum SpoofIPOption {
  Random = 0,
  Custom = 1,
}

interface TemporarySettings {
  ipInfo: any;
  notifyId: string;
  profile: string;
  spoofIP: string;
}

export class Chameleon {
  public settings: any;
  private defaultSettings: any;
  private injectionScript: any;
  private intercept: Interceptor;
  private profileCache: any;
  private REGEX_UUID: RegExp;
  public intervalTimeout: any;
  public localization: object;
  public platform: any;
  public tempStore: TemporarySettings;
  public timeout: any;
  public version: string;

  constructor(initSettings: any) {
    this.settings = initSettings;
    this.defaultSettings = initSettings;
    this.tempStore = {
      ipInfo: {
        cache: null,
        lang: '',
        tz: '',
        updated: 0,
      },
      notifyId: '',
      profile: '',
      spoofIP: '',
    };
    this.injectionScript = null;
    this.intervalTimeout = null;
    this.localization = {};
    this.profileCache = {};
    this.version = browser.runtime.getManifest().version;
    this.REGEX_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  }

  public async buildInjectionScript() {
    if (this.injectionScript) {
      await this.injectionScript.unregister();
      this.injectionScript = null;
    }

    this.updateProfileCache();
    this.injectionScript = await browser.contentScripts.register({
      allFrames: true,
      matchAboutBlank: true,
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: ['http://127.0.0.1/*', 'http://localhost/*'],
      js: [
        {
          code: `
            let settings = JSON.parse(\`${JSON.stringify(this.settings)}\`);
            let tempStore = JSON.parse(\`${JSON.stringify(this.tempStore)}\`);
            let profileCache = JSON.parse(\`${JSON.stringify(this.profileCache)}\`);
            let seed = ${Math.random() * 0.00000001};
            let isDesktop = ${this.platform.os != 'android'};
          `,
        },
        { file: 'inject.js' },
      ],
      runAt: 'document_start',
    });
  }

  public async changeBrowserSettings(): Promise<void> {
    browser.privacy.websites.cookieConfig.set({
      value: {
        behavior: this.settings.options.cookiePolicy,
        nonPersistentCookies: this.settings.options.cookieNotPersistent,
      },
    });

    ['firstPartyIsolate', 'resistFingerprinting', 'trackingProtectionMode'].forEach(key => {
      browser.privacy.websites[key].set({
        value: this.settings.options[key],
      });
    });

    browser.privacy.network.peerConnectionEnabled.set({
      value: !this.settings.options.disableWebRTC,
    });

    browser.privacy.network.webRTCIPHandlingPolicy.set({
      value: this.settings.options.webRTCPolicy,
    });
  }

  public async init(storedSettings: any): Promise<void> {
    if (/0\.12/.test(storedSettings.version)) {
      this.migrateLegacy(storedSettings);
    } else {
      if (storedSettings.options) {
        this.settings = storedSettings;
      } else {
        this.settings = this.defaultSettings;
      }
    }

    // get current modified preferences
    let cookieSettings = await browser.privacy.websites.cookieConfig.get({});
    this.settings.options.cookieNotPersistent = cookieSettings.value.nonPersistentCookies;
    this.settings.options.cookiePolicy = cookieSettings.value.behavior;

    let firstPartyIsolate = await browser.privacy.websites.firstPartyIsolate.get({});
    this.settings.options.firstPartyIsolate = firstPartyIsolate.value;

    let resistFingerprinting = await browser.privacy.websites.resistFingerprinting.get({});
    this.settings.options.resistFingerprinting = resistFingerprinting.value;

    let trackingProtectionMode = await browser.privacy.websites.trackingProtectionMode.get({});
    this.settings.options.trackingProtectionMode = trackingProtectionMode.value;

    let peerConnectionEnabled = await browser.privacy.network.peerConnectionEnabled.get({});
    this.settings.options.disableWebRTC = !peerConnectionEnabled.value;

    let webRTCIPHandlingPolicy = await browser.privacy.network.webRTCIPHandlingPolicy.get({});
    this.settings.options.webRTCPolicy = webRTCIPHandlingPolicy.value;

    this.intercept = new Interceptor(this.settings, this.tempStore, this.profileCache);
    this.platform = await browser.runtime.getPlatformInfo();
    await this.saveSettings(this.settings);

    this.tempStore.notifyId =
      String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
      Math.random()
        .toString(36)
        .substring(Math.floor(Math.random() * 5) + 5);
  }

  private getProfileInUse(): string {
    if (this.settings.profile.selected === 'none' || this.settings.excluded.includes(this.settings.profile.selected) || this.tempStore.profile === 'none') {
      return this.localization['text.realProfile'];
    } else {
      let profiles: any = new prof.Generator().getAllProfiles();
      for (let k of Object.keys(profiles)) {
        let found = profiles[k].find(p => p.id == (/\d/.test(this.settings.profile.selected) ? this.settings.profile.selected : this.tempStore.profile));
        if (found != null) {
          return found.name;
        }
      }
    }
  }

  private migrateLegacy(prev: any, importing: boolean = false): object {
    let s: any = Object.assign({}, this.defaultSettings);
    let msg: string = '';

    let languages: lang.Language[] = lang.getAllLanguages();
    let profiles = new prof.Generator().getAllProfiles();
    let timezoneIds: string[] = getTimezones().map(t => t.zone);
    let mappedProfiles = {
      custom: ' none',
      real: 'none',
      none: 'none',
      random: 'random',
      randomDesktop: 'randomDesktop',
      randomMobile: 'randomMobile',
      win1: 'win1-gcr',
      win2: 'win2-gcr',
      win3: 'win3-gcr',
      win4: 'win4-gcr',
      win6: 'win1-ff',
      win7: 'win2-ff',
      win8: 'win3-ff',
      win9: 'win4-ff',
      win10: 'win2-ie',
      win11: 'win1-ie',
      win12: 'win3-ie',
      win13: 'win1-esr',
      win14: 'win3-esr',
      win15: 'win4-esr',
      win16: 'win4-ie',
      mac1: 'mac1-gcr',
      mac2: 'mac2-gcr',
      mac3: 'mac1-ff',
      mac4: 'mac2-ff',
      mac5: 'mac1-sf',
      mac6: 'mac2-sf',
      mac7: 'mac3-sf',
      mac8: 'mac1-esr',
      linux1: 'lin1-gcr',
      linux2: 'lin2-gcr',
      linux3: 'lin3-gcr',
      linux4: 'lin1-cr',
      linux5: 'lin2-cr',
      linux6: 'lin3-cr',
      linux7: 'lin1-ff',
      linux8: 'lin2-ff',
      linux9: 'lin3-ff',
      linux10: 'lin1-esr',
      linux11: 'lin3-esr',
      ios1: 'ios1-sfm',
      ios2: 'ios1-sft',
      ios3: 'ios1-gcrm',
      ios4: 'ios2-sft',
      ios5: 'ios2-gcrm',
      ios6: 'ios2-sfm',
      ios7: 'ios3-sfm',
      ios8: 'ios3-sft',
      ios9: 'ios3-gcrm',
      android1: 'and4-ff',
      android2: 'and1-gcrm',
      android3: 'and1-gcrm',
      android4: 'and2-gcrm',
      android5: 'and2-gcrm',
      android6: 'and3-gcrm',
      android7: 'and3-gcrm',
      android8: 'and3-gcrm',
      android9: 'and4-gcrm',
    };

    if (!prev.settings && importing) {
      msg = this.localization['options.import.invalid.settings'];

      return {
        error: true,
        msg,
      };
    } else {
      if (importing) {
        let options = [
          ['config.notificationsEnabled', prev.settings.notificationsEnabled, 'boolean'],
          ['options.limitHistory', prev.settings.limitHistory, 'boolean'],
          ['options.protectWinName', prev.settings.protectWinName, 'boolean'],
          ['profile.interval.option', prev.settings.interval, [0, -1, 1, 5, 10, 20, 30, 40, 50, 60]],
          ['profile.interval.min', prev.settings.minInterval === null ? 1 : prev.settings.minInterval, 'number'],
          ['profile.interval.max', prev.settings.maxInterval === null ? 1 : prev.settings.maxInterval, 'number'],
          ['options.spoofClientRects', prev.settings.spoofClientRects, 'boolean'],
          ['options.spoofAudioContext', prev.settings.spoofAudioContext, 'boolean'],
          ['options.webSockets', prev.settings.webSockets, ['allow_all', 'block_3rd_party', 'block_all']],
          ['options.protectKBFingerprint.enabled', prev.settings.protectKeyboardFingerprint, 'boolean'],
          ['options.protectKBFingerprint.delay', prev.settings.kbDelay, 'number'],
          ['options.screenSize', prev.settings.screenSize, ['default', 'profile', '1366x768', '1440x900', '1600x900', '1920x1080', '2560x1440', '2560x1600']],
          ['options.timeZone', prev.settings.timeZone, timezoneIds.concat(['default', 'ip'])],
        ];

        for (let i = 0; i < options.length; i++) {
          let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
          if (v.error) {
            return v;
          }
        }
      }

      s.config.notificationsEnabled = prev.settings.notificationsEnabled;
      s.options.limitHistory = prev.settings.limitHistory;
      s.options.protectWinName = prev.settings.protectWinName;
      s.profile.interval.option = prev.settings.interval;
      s.profile.interval.min = prev.settings.minInterval === null ? 1 : prev.settings.minInterval;
      s.profile.interval.max = prev.settings.maxInterval === null ? 1 : prev.settings.maxInterval;
      s.options.spoofClientRects = prev.settings.spoofClientRects;
      s.options.spoofAudioContext = prev.settings.spoofAudioContext;
      s.options.webSockets = prev.settings.webSockets;
      s.options.protectKBFingerprint.enabled = prev.settings.protectKeyboardFingerprint;
      s.options.protectKBFingerprint.delay = prev.settings.kbDelay;
      s.options.screenSize = prev.settings.screenSize;
      s.options.timeZone = prev.settings.timeZone;

      if (prev.settings.useragent) {
        if (prev.settings.useragent in mappedProfiles) {
          s.profile.selected = mappedProfiles[prev.settings.useragent];
        } else {
          if (importing) {
            msg = this.localization['options.import.invalid.profile'];

            return {
              error: true,
              msg,
            };
          }
        }
      }
    }

    if (!prev.headers && importing) {
      msg = this.localization['options.import.invalid.headers'];

      return {
        error: true,
        msg,
      };
    } else {
      let spoofLangValue: string = '';

      if (prev.headers.spoofAcceptLangValue === '') {
        spoofLangValue = 'default';
      } else if (prev.headers.spoofAcceptLangValue === 'ip') {
        spoofLangValue = 'ip';
      } else {
        spoofLangValue = languages.find(l => l.value === prev.headers.spoofAcceptLangValue).code;
      }

      if (importing) {
        // can be a string...sometimes??
        prev.headers.refererXorigin = Number(prev.headers.refererXorigin) || 0;
        prev.headers.refererTrimming = Number(prev.headers.refererTrimming) || 0;

        let options = [
          ['headers.blockEtag', prev.headers.blockEtag, 'boolean'],
          ['headers.enableDNT', prev.headers.enableDNT, 'boolean'],
          ['headers.referer.disabled', prev.headers.disableRef, 'boolean'],
          ['headers.referer.xorigin', prev.headers.refererXorigin, [0, 1, 2]],
          ['headers.referer.trimming', prev.headers.refererTrimming, [0, 1, 2]],
          ['headers.spoofAcceptLang.enabled', prev.headers.spoofAcceptLang, 'boolean'],
          ['headers.spoofAcceptLang.value', spoofLangValue, ['default', 'ip'].concat(languages.map(l => l.code))],
          ['headers.spoofIP.enabled', prev.headers.spoofIP, 'boolean'],
          ['headers.spoofIP.option', Number(prev.headers.spoofIPValue), [0, 1]],
          ['headers.spoofIP.rangeFrom', util.isValidIP(prev.headers.rangeFrom), 'boolean'],
          ['headers.spoofIP.rangeTo', util.isValidIP(prev.headers.rangeTo), 'boolean'],
        ];

        for (let i = 0; i < options.length; i++) {
          let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
          if (v.error) {
            return v;
          }
        }
      }

      s.headers.blockEtag = prev.headers.blockEtag;
      s.headers.enableDNT = prev.headers.enableDNT;
      s.headers.referer.disabled = prev.headers.disableRef;
      s.headers.referer.xorigin = prev.headers.refererXorigin;
      s.headers.referer.trimming = prev.headers.refererTrimming;
      s.headers.spoofAcceptLang.enabled = prev.headers.spoofAcceptLang;
      s.headers.spoofAcceptLang.value = spoofLangValue;
      s.headers.spoofIP.enabled = prev.headers.spoofIP;
      s.headers.spoofIP.option = prev.headers.spoofIPValue;
      s.headers.spoofIP.rangeFrom = prev.headers.rangeFrom;
      s.headers.spoofIP.rangeTo = prev.headers.rangeTo;
    }

    if (!prev.excluded && importing) {
      msg = this.localization['options.import.invalid.excluded'];

      return {
        error: true,
        msg,
      };
    } else {
      let excludedProfiles = new Set();

      ['win', 'mac', 'linux', 'ios', 'android'].forEach(platform => {
        prev.excluded[platform].filter((isExcluded: boolean, i: number) => {
          if (isExcluded) {
            if (`${platform}${i + 1}` === 'win5') {
              // exclude all edge profiles
              excludedProfiles.add('win1-edg');
              excludedProfiles.add('win2-edg');
              excludedProfiles.add('win3-edg');
              excludedProfiles.add('win4-edg');
            } else {
              excludedProfiles.add(mappedProfiles[`${platform}${i + 1}`]);
            }
          }
        });
      });

      // assumes that if all esr versions were excluded then this one should be too
      if (prev.excluded.win[12] && prev.excluded.win[13] && prev.excluded.win[14]) {
        excludedProfiles.add('win2-esr');
      }

      let platforms = ['windows', 'macOS', 'linux', 'iOS', 'android'];
      prev.excluded.all.filter((isExcluded: boolean, i: number) => {
        if (isExcluded) {
          profiles[platforms[i]].forEach(p => {
            excludedProfiles.add(p.id);
          });
        }
      });

      s.excluded = Array.from(excludedProfiles);
    }

    if (!prev.ipRules && importing) {
      msg = this.localization['options.import.invalid.ipRules'];

      return {
        error: true,
        msg,
      };
    } else {
      for (let i = 0; i < prev.ipRules.length; i++) {
        let ipRule: any = {};

        ipRule.id = uuidv4();
        ipRule.name = `Rule #${i + 1}`;
        ipRule.lang = languages.find(l => l.name == prev.ipRules[i].lang).code;
        ipRule.tz = prev.ipRules[i].tz;
        ipRule.ips = [];

        for (let j = 0; j < prev.ipRules[i].ip.length; j++) {
          ipRule.ips.push(util.getIPRange(prev.ipRules[i].ip[j]));
        }

        s.ipRules.push(ipRule);
      }
    }

    if (!prev.whitelist && importing) {
      msg = this.localization['options.import.invalid.whitelist'];

      return {
        error: true,
        msg,
      };
    } else {
      if (importing) {
        let options = [
          ['whitelist.enabledContextMenu', prev.whitelist.enabledContextMenu, 'boolean'],
          ['whitelist.defaultProfile', prev.whitelist.defaultProfile, Object.keys(mappedProfiles)],
        ];

        for (let i = 0; i < options.length; i++) {
          let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
          if (v.error) {
            return v;
          }
        }
      }

      s.whitelist.enabledContextMenu = prev.whitelist.enabledContextMenu;
      s.whitelist.defaultProfile = mappedProfiles[prev.whitelist.defaultProfile];
      s.whitelist.rules = [];

      for (let i = 0; i < prev.whitelist.urlList.length; i++) {
        let wlRule: any = {};

        wlRule.id = uuidv4();
        wlRule.name = `Rule #${i + 1}`;
        wlRule.sites = [];

        for (let j = 0; j < prev.whitelist.urlList[i].domains.length; j++) {
          let site: any = {
            domain: prev.whitelist.urlList[i].domains[j].domain,
          };

          if (prev.whitelist.urlList[i].domains[j].pattern != '') {
            site.pattern = prev.whitelist.urlList[i].domains[j].pattern;
          }

          wlRule.sites.push(site);
        }

        wlRule.spoofIP = prev.whitelist.urlList[i].spoofIP;
        wlRule.profile = prev.whitelist.urlList[i].profile === 'default' ? 'default' : mappedProfiles[prev.whitelist.urlList[i].profile];

        let tempLang = languages.find(l => l.value === prev.whitelist.urlList[i].lang);
        wlRule.lang = tempLang ? tempLang.code : 'en-US';

        wlRule.options = {
          name: prev.whitelist.urlList[i].options.winName === true,
          ref: prev.whitelist.urlList[i].options.ref === true,
          tz: prev.whitelist.urlList[i].options.timezone === true,
          ws: prev.whitelist.urlList[i].options.websocket === true,
        };

        s.whitelist.rules.push(wlRule);
      }
    }

    if (importing) {
      setTimeout(async () => {
        await this.saveSettings(s);
        browser.runtime.reload();
      }, 2500);

      msg = this.localization['options.import.success'];

      return {
        error: false,
        msg,
      };
    } else {
      this.settings = s;
    }
  }

  private updateProfileCache(): void {
    let profGen = new prof.Generator();

    // update cache for default whitelist profile
    if (!(this.settings.whitelist.defaultProfile in this.profileCache) && this.settings.whitelist.defaultProfile != 'none') {
      this.profileCache[this.settings.whitelist.defaultProfile] = profGen.getProfile(this.settings.whitelist.defaultProfile);
    }

    // update cache for whitelist profiles
    for (let i = 0; i < this.settings.whitelist.rules.length; i++) {
      let p: string = this.settings.whitelist.rules[i].profile;

      if (!['default', 'none'].includes(p) && !(p in this.profileCache)) {
        this.profileCache[p] = profGen.getProfile(p);
      }
    }

    // update cache for selected profile
    if (this.settings.profile.selected.includes('-')) {
      if (!(this.settings.profile.selected in this.profileCache)) {
        this.profileCache[this.settings.profile.selected] = profGen.getProfile(this.settings.profile.selected);
      }
    }

    // update cache for temp profile
    if (this.tempStore.profile && this.tempStore.profile != 'none') {
      if (!(this.tempStore.profile in this.profileCache)) {
        this.profileCache[this.tempStore.profile] = profGen.getProfile(this.tempStore.profile);
      }
    }
  }

  public localize(): void {
    let keys = [
      'extDescription',
      'notifications.profileChange',
      'notifications.unableToGetIPInfo',
      'notifications.usingIPInfo',
      'notifications.usingIPRule',
      'options.about.wiki',
      'options.about.issueTracker',
      'options.about.knownIssues',
      'options.about.support',
      'options.about.sourceCode',
      'options.about.translate',
      'options.checklist.close',
      'options.checklist.leaveEmpty',
      'options.checklist.note1',
      'options.checklist.note2',
      'options.checklist.warning',
      'options.checklistItem.blockActiveMixedContent',
      'options.checklistItem.blockActiveMixedContentDesc',
      'options.checklistItem.blockDisplayMixedContent',
      'options.checklistItem.blockDisplayMixedContentDesc',
      'options.checklistItem.disableAddonCache',
      'options.checklistItem.disableAddonCacheDesc',
      'options.checklistItem.disableAddonUpdates',
      'options.checklistItem.disableAddonUpdatesDesc',
      'options.checklistItem.disableBattery',
      'options.checklistItem.disableBatteryDesc',
      'options.checklistItem.disableHistory',
      'options.checklistItem.disableHistoryDesc',
      'options.checklistItem.disableCacheDisk',
      'options.checklistItem.disableCacheDiskDesc',
      'options.checklistItem.disableCacheMem',
      'options.checklistItem.disableCacheMemDesc',
      'options.checklistItem.disableClipboardEvt',
      'options.checklistItem.disableClipboardEvtDesc',
      'options.checklistItem.disableContextMenuEvt',
      'options.checklistItem.disableContextMenuEvtDesc',
      'options.checklistItem.disableMobileSensors',
      'options.checklistItem.disableMobileSensorsDesc',
      'options.checklistItem.disableDNSPrefetch',
      'options.checklistItem.disableDNSPrefetchDesc',
      'options.checklistItem.disableDOMStorage',
      'options.checklistItem.disableDOMStorageDesc',
      'options.checklistItem.disableDRM',
      'options.checklistItem.disableDRMDesc',
      'options.checklistItem.disableGeo',
      'options.checklistItem.disableGeoDesc',
      'options.checklistItem.disableGeo2',
      'options.checklistItem.disableGeo2Desc',
      'options.checklistItem.disableIDN',
      'options.checklistItem.disableIDNDesc',
      'options.checklistItem.disableOfflineCache',
      'options.checklistItem.disableOfflineCacheDesc',
      'options.checklistItem.disablePDF',
      'options.checklistItem.disablePDFDesc',
      'options.checklistItem.disablePocket',
      'options.checklistItem.disablePocketDesc',
      'options.checklistItem.disableResTiming',
      'options.checklistItem.disableResTimingDesc',
      'options.checklistItem.disableSearchSuggest',
      'options.checklistItem.disableSearchSuggestDesc',
      'options.checklistItem.disableSearchUpdates',
      'options.checklistItem.disableSearchUpdatesDesc',
      'options.checklistItem.disableSpeculatePreConn',
      'options.checklistItem.disableSpeculatePreConnDesc',
      'options.checklistItem.disableSSLFalseStart',
      'options.checklistItem.disableSSLFalseStartDesc',
      'options.checklistItem.disableSSLSessId',
      'options.checklistItem.disableSSLSessIdDesc',
      'options.checklistItem.disableTLSRTT',
      'options.checklistItem.disableTLSRTTDesc',
      'options.checklistItem.disableTRR',
      'options.checklistItem.disableTRRDesc',
      'options.checklistItem.disableWebGL',
      'options.checklistItem.disableWebGLDesc',
      'options.checklistItem.disableWebBeacons',
      'options.checklistItem.disableWebBeaconsDesc',
      'options.checklistItem.clearOfflineApps',
      'options.checklistItem.clearOfflineAppsDesc',
      'options.checklistItem.enableSocialTrackingProtect',
      'options.checklistItem.enableSocialTrackingProtectDesc',
      'options.checklistItem.limitFonts',
      'options.checklistItem.limitFontsDesc',
      'options.checklistItem.limitMaxTabsUndo',
      'options.checklistItem.limitMaxTabsUndoDesc',
      'options.checklistItem.useClickToPlay',
      'options.checklistItem.useClickToPlayDesc',
      'options.checklistItem.disableDataSubmission',
      'options.checklistItem.disableDataSubmissionDesc',
      'options.checklistItem.disableSafeBrowsingDownloadCheck',
      'options.checklistItem.disableSafeBrowsingDownloadCheckDesc',
      'options.checklistItem.disableSafeBrowsingDownloadCheck2',
      'options.checklistItem.disableSafeBrowsingDownloadCheck2Desc',
      'options.checklistItem.disableSafeBrowsingDownloadCheck3',
      'options.checklistItem.disableSafeBrowsingDownloadCheck3Desc',
      'options.checklistItem.disableSafeBrowsingDownloadCheck4',
      'options.checklistItem.disableSafeBrowsingDownloadCheck4Desc',
      'options.checklistItem.disableSafeBrowsingMalwareCheck',
      'options.checklistItem.disableSafeBrowsingMalwareCheckDesc',
      'options.checklistItem.disableSafeBrowsingPhishingCheck',
      'options.checklistItem.disableSafeBrowsingPhishingCheckDesc',
      'options.checklistItem.disableHealthReport',
      'options.checklistItem.disableHealthReportDesc',
      'options.checklistItem.disableCrashReport',
      'options.checklistItem.disableCrashReportDesc',
      'options.checklistItem.disableTelemetryPing',
      'options.checklistItem.disableTelemetryPingDesc',
      'options.checklistItem.disableTelemetryReport',
      'options.checklistItem.disableTelemetryReportDesc',
      'options.checklistItem.disableTelemetryReport2',
      'options.checklistItem.disableTelemetryReport2Desc',
      'options.checklistItem.sessionPrivacyLevel',
      'options.checklistItem.sessionPrivacyLevelDesc',
      'options.import.couldNotImport',
      'options.import.invalid.config',
      'options.import.invalid.excluded',
      'options.import.invalid.excludedProfile',
      'options.import.invalid.headers',
      'options.import.invalid.ipRuleId',
      'options.import.invalid.ipRuleName',
      'options.import.invalid.ipRuleRange',
      'options.import.invalid.ipRules',
      'options.import.invalid.ipRulesDupe',
      'options.import.invalid.options',
      'options.import.invalid.profile',
      'options.import.invalid.setting',
      'options.import.invalid.settings',
      'options.import.invalid.spoofIP',
      'options.import.invalid.version',
      'options.import.invalid.whitelist',
      'options.import.invalid.whitelistDupe',
      'options.import.invalid.whitelistId',
      'options.import.invalid.whitelistName',
      'options.import.invalid.whitelistOpt',
      'options.import.invalid.whitelistSpoofIP',
      'options.import.success',
      'options.ipRules.editorTitle',
      'options.ipRules.ipRule',
      'options.ipRules.reload',
      'options.ipRules.textareaLabel',
      'options.ipRules.textareaPlaceholder',
      'options.modal.askDelete',
      'options.modal.askReset',
      'options.modal.confirmDelete',
      'options.modal.confirmReset',
      'options.settings',
      'options.settings.import',
      'options.settings.importing',
      'options.settings.export',
      'options.settings.reset',
      'options.tab.about',
      'options.tab.ipRules',
      'options.tab.checklist',
      'options.whitelist.acceptLang',
      'options.whitelist.editorTitle',
      'options.whitelist.headerIPLabel',
      'options.whitelist.options.name',
      'options.whitelist.options.tz',
      'options.whitelist.options.ws',
      'options.whitelist.rule',
      'options.whitelist.sitesTip',
      'options.whitelist.textareaLabel',
      'options.whitelist.textareaPlaceholder',
      'options.whitelist.urls',
      'popup.home.change',
      'popup.home.currentProfile',
      'popup.home.currentProfile.defaultLanguage',
      'popup.home.currentProfile.defaultScreen',
      'popup.home.currentProfile.defaultTimezone',
      'popup.home.currentProfile.gettingTimezone',
      'popup.home.disabled',
      'popup.home.enabled',
      'popup.home.notification.disabled',
      'popup.home.notification.enabled',
      'popup.home.onThisPage',
      'popup.home.theme.dark',
      'popup.home.theme.light',
      'popup.profile.changePeriodically',
      'popup.profile.devicePhone',
      'popup.profile.deviceTablet',
      'popup.profile.interval.no',
      'popup.profile.interval.custom',
      'popup.profile.interval.customMax',
      'popup.profile.interval.customMin',
      'popup.profile.interval.minute',
      'popup.profile.interval.5minutes',
      'popup.profile.interval.10minutes',
      'popup.profile.interval.20minutes',
      'popup.profile.interval.30minutes',
      'popup.profile.interval.40minutes',
      'popup.profile.interval.50minutes',
      'popup.profile.interval.hour',
      'popup.profile.exclude',
      'popup.profile.randomAndroid',
      'popup.profile.randomIOS',
      'popup.profile.randomMacOS',
      'popup.profile.randomLinux',
      'popup.profile.randomWindows',
      'popup.profile.random',
      'popup.profile.randomDesktopProfile',
      'popup.profile.randomMobileProfile',
      'popup.headers',
      'popup.headers.enableDNT',
      'popup.headers.preventEtag',
      'popup.headers.refererWarning',
      'popup.headers.referer.trimming',
      'popup.headers.referer.trimming.sendFullURI',
      'popup.headers.referer.trimming.schemeHostPortPath',
      'popup.headers.referer.trimming.schemeHostPort',
      'popup.headers.referer.xorigin',
      'popup.headers.referer.xorigin.alwaysSend',
      'popup.headers.referer.xorigin.matchBaseDomain',
      'popup.headers.referer.xorigin.matchHost',
      'popup.headers.spoofAcceptLang',
      'popup.headers.spoofIP',
      'popup.headers.spoofIP.random',
      'popup.headers.spoofIP.custom',
      'popup.headers.spoofIP.rangeFrom',
      'popup.headers.spoofIP.rangeTo',
      'popup.options',
      'popup.options.aboutConfigButton',
      'popup.options.injection',
      'popup.options.injection.limitTabHistory',
      'popup.options.injection.protectWinName',
      'popup.options.injection.audioContext',
      'popup.options.injection.clientRects',
      'popup.options.injection.protectKBFingerprint',
      'popup.options.injection.protectKBFingerprintDelay',
      'popup.options.injection.screen',
      'popup.options.injection.spoofFontFingerprint',
      'popup.options.standard',
      'popup.options.standard.blockMediaDevices',
      'popup.options.standard.disableWebRTC',
      'popup.options.standard.firstPartyIsolation',
      'popup.options.standard.resistFingerprinting',
      'popup.options.standard.trackingProtection',
      'popup.options.standard.trackingProtection.on',
      'popup.options.standard.trackingProtection.off',
      'popup.options.standard.trackingProtection.privateBrowsing',
      'popup.options.standard.webRTCPolicy',
      'popup.options.standard.webRTCPolicy.nonProxified',
      'popup.options.standard.webRTCPolicy.public',
      'popup.options.standard.webRTCPolicy.publicPrivate',
      'popup.options.standard.webSockets.blockAll',
      'popup.options.standard.webSockets.blockThirdParty',
      'popup.options.cookie',
      'popup.options.cookieNotPersistent',
      'popup.options.cookiePolicy',
      'popup.options.cookiePolicy.allowVisited',
      'popup.options.cookiePolicy.rejectAll',
      'popup.options.cookiePolicy.rejectThirdParty',
      'popup.options.cookiePolicy.rejectTrackers',
      'popup.whitelist.contextMenu',
      'popup.whitelist.defaultProfileLabel',
      'popup.whitelist.enable',
      'popup.whitelist.isNotWhitelisted',
      'popup.whitelist.isWhitelisted',
      'popup.whitelist.open',
      'text.allowAll',
      'text.cancel',
      'text.createNewRule',
      'text.default',
      'text.defaultWhitelistProfile',
      'text.disableReferer',
      'text.language',
      'text.name',
      'text.profile',
      'text.realProfile',
      'text.save',
      'text.screen',
      'text.searchRules',
      'text.timezone',
      'text.whitelist',
    ];

    for (let k of keys) {
      this.localization[k] = browser.i18n.getMessage(k);
    }
  }

  public reset(): void {
    this.saveSettings(this.defaultSettings);
  }

  public run(): void {
    this.start();

    if (this.settings.config.notificationsEnabled) {
      browser.notifications.create({
        type: 'basic',
        title: 'Chameleon',
        message: `${this.localization['notifications.profileChange']} ` + this.getProfileInUse(),
      });
    }
  }

  /*
    Allow Chameleon to be controlled by another extension

    Enabled only in developer builds
  */
  public setupExternalListeners(): void {
    if (browser.runtime.getManifest().version_name.includes('-')) {
      browser.runtime.onConnectExternal.addListener(port => {
        port.onMessage.addListener(request => {
          console.log('received request: ' + JSON.stringify(request));
          browser.runtime.sendMessage(request).then(response => {
            port.postMessage(response);
          });
        });
      });
    }
  }

  public setupHeaderListeners(): void {
    /* Block websocket connections */
    browser.webRequest.onBeforeRequest.addListener(
      details => {
        return this.intercept.blockWebsocket(details);
      },
      {
        urls: ['<all_urls>'],
      },
      ['blocking']
    );

    /* Modify request headers and block websocket long polling connections */
    browser.webRequest.onBeforeSendHeaders.addListener(
      details => {
        return this.intercept.modifyRequest(details);
      },
      {
        urls: ['<all_urls>'],
      },
      ['blocking', 'requestHeaders']
    );

    /* Block etags */
    browser.webRequest.onHeadersReceived.addListener(
      details => {
        return this.intercept.modifyResponse(details);
      },
      {
        urls: ['<all_urls>'],
      },
      ['blocking', 'responseHeaders']
    );
  }

  public setTimer(option = null): void {
    browser.alarms.clearAll();

    let alarmInfo = { when: Date.now() + 250 };

    if (option === null) option = this.settings.profile.interval.option;

    if (option != IntervalOption.None) {
      if (option === IntervalOption.Custom) {
        if (!this.settings.profile.interval.min || !this.settings.profile.interval.max) return;

        let interval: number =
          Math.random() * (this.settings.profile.interval.max * 60 * 1000 - this.settings.profile.interval.min * 60 * 1000) + this.settings.profile.interval.min * 60 * 1000;

        /* 
          Use regular timeout for custom interval
          Allows irregular periods between alarm  
        */

        if (this.intervalTimeout) clearTimeout(this.intervalTimeout);
        let _this = this;
        this.intervalTimeout = setTimeout(function() {
          _this.setTimer();
        }, interval);
      } else {
        alarmInfo['periodInMinutes'] = option;
      }
    }

    browser.alarms.create(alarmInfo);
  }

  public start(): void {
    this.updateProfile(this.settings.profile.selected);
    this.updateSpoofIP();
    this.buildInjectionScript();

    this.tempStore.notifyId =
      String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
      Math.random()
        .toString(36)
        .substring(Math.floor(Math.random() * 5) + 5);
  }

  public async saveSettings(settings: any): Promise<void> {
    await webext.setSettings({ ...settings, version: this.version });
  }

  public async updateIPInfo(forceCheck: boolean): Promise<void> {
    try {
      let notificationMsg: string;

      // cache results for 1m
      if (forceCheck || this.tempStore.ipInfo.updated + 60000 < new Date().getTime()) {
        let res = await fetch('https://ipapi.co/json');
        this.tempStore.ipInfo.cache = await res.json();
        this.tempStore.ipInfo.updated = new Date().getTime();
      }

      let data = this.tempStore.ipInfo.cache;

      if ((data.timezone && data.languages) || data.ip) {
        // check if IP defined in IP rules
        let foundRule: boolean = false;

        for (let i = 0; i < this.settings.ipRules.length; i++) {
          for (let j = 0; j < this.settings.ipRules[i].ips.length; j++) {
            if (util.ipInRange(data.ip, this.settings.ipRules[i].ips[j].split('-'))) {
              foundRule = true;
              this.tempStore.ipInfo.lang = this.settings.ipRules[i].lang;
              this.tempStore.ipInfo.tz = this.settings.ipRules[i].tz;

              notificationMsg = `${this.localization['notifications.usingIPRule']} ${this.tempStore.ipInfo.tz}, ${lang.getLanguage(this.tempStore.ipInfo.lang).name}`;
            }
          }
        }

        if (!foundRule) {
          if ((data.timezone === '' && this.settings.options.timeZone === 'ip') || (data.languages === '' && this.settings.headers.spoofAcceptLang.value === 'ip')) {
            throw 'Couldn\'t find info';
          }

          notificationMsg = `${this.localization['notifications.usingIPInfo']} `;

          if (this.settings.options.timeZone === 'ip') {
            this.tempStore.ipInfo.tz = data.timezone;
            notificationMsg = `${notificationMsg} ${data.timezone}${this.settings.headers.spoofAcceptLang.value === 'ip' ? ', ' : ''}`;
          }

          if (this.settings.headers.spoofAcceptLang.value === 'ip') {
            let ipLang: string = data.languages.split(',')[0];
            let allLanguages: lang.Language[] = lang.getAllLanguages();
            let foundLang: lang.Language = lang.getLanguage('en-US'); // use english as default

            if (ipLang !== 'en' && ipLang !== 'en-US') {
              foundLang = allLanguages.find(l => l.nav.includes(ipLang));

              if (foundLang !== null) {
                this.tempStore.ipInfo.lang = foundLang.code;
              } else {
                let languageIndexes = [];

                // find primary ip lang in existing langauges
                // compare with other returned results
                // get closest match
                let ipLangPrimary = ipLang.split('-')[0];
                if (ipLangPrimary !== 'en') {
                  for (let i = 0; i < allLanguages.length; i++) {
                    let idx = allLanguages.findIndex(l => l.nav.includes(ipLangPrimary));

                    if (idx > -1) {
                      languageIndexes.push([
                        idx > -1,
                        i, // language index
                        idx, // index of found primary ip lang
                      ]);
                    }
                  }
                }

                if (languageIndexes.length > 0) {
                  languageIndexes.sort((a: any, b: any): number => {
                    if (a[2] > b[2]) {
                      return 1;
                    }
                    if (a[2] < b[2]) {
                      return -1;
                    }
                    return 0;
                  });

                  foundLang = allLanguages[languageIndexes[0][1]];
                  this.tempStore.ipInfo.lang = foundLang.code;
                }
              }

              notificationMsg = `${notificationMsg} ${foundLang.name}`;
            }
          }
        }

        browser.runtime.sendMessage({
          action: 'tempStore',
          data: this.tempStore,
        });

        browser.notifications.create({
          type: 'basic',
          title: 'Chameleon',
          message: notificationMsg,
        });

        this.buildInjectionScript();
      }
    } catch (e) {
      let message: string = this.localization['notifications.unableToGetIPInfo'];

      browser.notifications.create({
        type: 'basic',
        title: 'Chameleon',
        message,
      });
    }
  }

  public updateProfile(profile: string): void {
    // update current profile if random selected
    if (!/\d|none/.test(profile)) {
      let profiles: prof.Generator = new prof.Generator(this.settings.excluded);
      if (profile.includes('random')) {
        this.tempStore.profile = profiles.getRandomByDevice(profile);
      } else {
        this.tempStore.profile = profiles.getRandomByOS(profile);
      }
    } else {
      this.tempStore.profile = '';
    }

    browser.runtime.sendMessage({
      action: 'tempStore',
      data: this.tempStore,
    });
  }

  public updateSpoofIP(): void {
    if (this.settings.headers.spoofIP.enabled) {
      if (this.settings.headers.spoofIP.option === SpoofIPOption.Random) {
        this.tempStore.spoofIP = util.generateIP();
      } else {
        let rangeFrom = util.ipToInt(this.settings.headers.spoofIP.rangeFrom);
        let rangeTo = util.ipToInt(this.settings.headers.spoofIP.rangeTo);

        this.tempStore.spoofIP = util.ipToString(Math.floor(Math.random() * (rangeTo - rangeFrom + 1) + rangeFrom));
      }
    }
  }

  private checkValidOption(settingName: string, settingValue: any, possibleValues: any): any {
    if (possibleValues === 'boolean' && typeof settingValue === 'boolean') {
      return {
        error: false,
      };
    } else if (possibleValues === 'number' && typeof settingValue === 'number') {
      return {
        error: false,
      };
    } else if (possibleValues.includes(settingValue)) {
      return {
        error: false,
      };
    }

    return {
      error: true,
      msg: `${this.localization['options.import.invalid.setting']} ${settingName}`,
    };
  }

  public toggleContextMenu(enabled: boolean): void {
    browser.contextMenus.removeAll();

    if (enabled && this.platform.os != 'android') {
      let rules: any = this.settings.whitelist.rules;

      browser.contextMenus.create({
        id: 'chameleon-openInWhitelist',
        title: 'Open in whitelist editor',
        contexts: ['page'],
        onclick: function(details) {
          var l = document.createElement('a');
          l.href = details.pageUrl;

          if (['http:', 'https:'].includes(l.protocol)) {
            let rule = util.findWhitelistRule(rules, l.host, l.href);

            if (rule !== null) {
              browser.tabs.create({
                url: browser.runtime.getURL(`/options/options.html#whitelist?id=${rule.id}}`),
              });
              return;
            }

            browser.tabs.create({
              url: browser.runtime.getURL(`/options/options.html#whitelist?site=${l.host}`),
            });
          }
        },
        icons: {
          '16': 'icon/icon_16.png',
          '32': 'icon/icon_32.png',
        },
      });
    }
  }

  public validateSettings(impSettings: any): object {
    if (/0\.12/.test(impSettings.version)) {
      return this.migrateLegacy(impSettings, true);
    }

    let s: any = Object.assign({}, this.defaultSettings);
    let msg: string = '';

    let profiles = new prof.Generator().getAllProfiles();
    let keys = Object.keys(profiles);

    let profileIds: string[] = [];
    for (let k of keys) {
      profileIds = profileIds.concat(profiles[k].map(p => p.id));
    }

    let languageIds: string[] = lang.getAllLanguages().map(l => l.code);
    let timezoneIds: string[] = getTimezones().map(t => t.zone);

    if (impSettings.version.split('.', 3).join('.') > this.settings.version.split('.', 3).join('.')) {
      msg = this.localization['options.import.invalid.version'];

      return {
        error: true,
        msg,
      };
    }

    if (!impSettings.config) {
      msg = this.localization['options.import.invalid.config'];

      return {
        error: true,
        msg,
      };
    } else {
      let options = [
        ['config.enabled', impSettings.config.enabled, 'boolean'],
        ['config.notificationsEnabled', impSettings.config.notificationsEnabled, 'boolean'],
        ['config.theme', impSettings.config.theme, ['light', 'dark']],
      ];

      for (let i = 0; i < options.length; i++) {
        let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
        if (v.error) {
          return v;
        } else {
          let parts: string[] = options[i][0].split('.');
          let lastIndex: string = parts[parts.length - 1];
          let nSetting = parts.slice(0, -1).reduce((o, i) => o[i], s);
          let oSetting = parts.slice(0, -1).reduce((o, i) => o[i], impSettings);

          nSetting[lastIndex] = oSetting[lastIndex];
        }
      }
    }

    if (!impSettings.excluded) {
      msg = this.localization['options.import.invalid.excluded'];

      return {
        error: true,
        msg,
      };
    } else {
      if (!impSettings.excluded.every(p => profileIds.includes(p))) {
        msg = this.localization['options.import.invalid.excludedProfile'];

        return {
          error: true,
          msg,
        };
      } else {
        s.excluded = impSettings.excluded;
      }
    }

    if (!impSettings.ipRules) {
      msg = this.localization['options.import.invalid.ipRules'];

      return {
        error: true,
        msg,
      };
    } else {
      let seen = new Set();
      let hasDupes: boolean = impSettings.ipRules.some(r => {
        return seen.size === seen.add(r.id).size;
      });

      if (hasDupes) {
        msg = this.localization['options.import.invalid.ipRulesDupe'];

        return {
          error: true,
          msg,
        };
      }

      for (let i = 0; i < impSettings.ipRules.length; i++) {
        let options = [
          ['ipRule.lang', impSettings.ipRules[i].lang, languageIds],
          ['ipRule.tz', impSettings.ipRules[i].tz, getTimezones().map(t => t.zone)],
        ];

        for (let i = 0; i < options.length; i++) {
          let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
          if (v.error) {
            return v;
          }
        }

        if (impSettings.ipRules[i].name === '') {
          msg = this.localization['options.import.invalid.ipRuleName'];

          return {
            error: true,
            msg,
          };
        }

        if (!this.REGEX_UUID.test(impSettings.ipRules[i].id)) {
          msg = this.localization['options.import.invalid.ipRuleId'];

          return {
            error: true,
            msg,
          };
        }

        // validate ip range
        for (let j = 0; j < impSettings.ipRules[i].ips.length; j++) {
          let ipRange: string[] = impSettings.ipRules[i].ips[j].split('-');

          if (ipRange.length > 2 || (ipRange.length === 2 && !util.validateIPRange(ipRange[0], ipRange[1])) || (ipRange.length === 1 && !util.isValidIP(ipRange[0]))) {
            msg = this.localization['options.import.invalid.ipRuleRange'];

            return {
              error: true,
              msg,
            };
          }
        }

        s.ipRules = impSettings.ipRules;
      }
    }

    if (!impSettings.profile) {
      msg = this.localization['options.import.invalid.profile'];

      return {
        error: true,
        msg,
      };
    } else {
      let options = [
        ['profile.selected', impSettings.profile.selected, profileIds.concat(['none', 'random', 'randomDesktop', 'randomMobile'])],
        ['profile.interval.option', impSettings.profile.interval.option, [0, -1, 1, 5, 10, 20, 30, 40, 50, 60]],
        ['profile.interval.min', impSettings.profile.interval.min, 'number'],
        ['profile.interval.max', impSettings.profile.interval.max, 'number'],
      ];

      for (let i = 0; i < options.length; i++) {
        let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
        if (v.error) {
          return v;
        } else {
          let parts: string[] = options[i][0].split('.');
          let lastIndex: string = parts[parts.length - 1];
          let nSetting = parts.slice(0, -1).reduce((o, i) => o[i], s);
          let oSetting = parts.slice(0, -1).reduce((o, i) => o[i], impSettings);

          nSetting[lastIndex] = oSetting[lastIndex];
        }
      }
    }

    if (!impSettings.headers) {
      msg = this.localization['options.import.invalid.headers'];

      return {
        error: true,
        msg,
      };
    } else {
      let options = [
        ['headers.blockEtag', impSettings.headers.blockEtag, 'boolean'],
        ['headers.enableDNT', impSettings.headers.enableDNT, 'boolean'],
        ['headers.referer.disabled', impSettings.headers.referer.disabled, 'boolean'],
        ['headers.referer.xorigin', impSettings.headers.referer.xorigin, [0, 1, 2]],
        ['headers.referer.trimming', impSettings.headers.referer.trimming, [0, 1, 2]],
        ['headers.spoofAcceptLang.enabled', impSettings.headers.spoofAcceptLang.enabled, 'boolean'],
        ['headers.spoofAcceptLang.value', impSettings.headers.spoofAcceptLang.value, languageIds.concat(['default', 'ip'])],
        ['headers.spoofIP.enabled', impSettings.headers.spoofIP.enabled, 'boolean'],
        ['headers.spoofIP.option', impSettings.headers.spoofIP.option, [0, 1]],
      ];

      for (let i = 0; i < options.length; i++) {
        let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
        if (v.error) {
          return v;
        } else {
          let parts: string[] = options[i][0].split('.');
          let lastIndex: string = parts[parts.length - 1];
          let nSetting = parts.slice(0, -1).reduce((o, i) => o[i], s);
          let oSetting = parts.slice(0, -1).reduce((o, i) => o[i], impSettings);

          nSetting[lastIndex] = oSetting[lastIndex];
        }
      }

      if (impSettings.headers.spoofIP.rangeFrom && impSettings.headers.spoofIP.rangeTo) {
        if (!util.validateIPRange(impSettings.headers.spoofIP.rangeFrom, impSettings.headers.spoofIP.rangeTo)) {
          msg = this.localization['options.import.invalid.spoofIP'];

          return {
            error: true,
            msg,
          };
        } else {
          s.headers.spoofIP.rangeFrom = impSettings.headers.spoofIP.rangeFrom;
          s.headers.spoofIP.rangeTo = impSettings.headers.spoofIP.rangeTo;
        }
      }
    }

    if (!impSettings.options) {
      msg = this.localization['options.import.invalid.options'];

      return {
        error: true,
        msg,
      };
    } else {
      let options = [
        ['options.blockMediaDevices', impSettings.options.blockMediaDevices, 'boolean'],
        ['options.disableWebRTC', impSettings.options.disableWebRTC, 'boolean'],
        ['options.firstPartyIsolate', impSettings.options.firstPartyIsolate, 'boolean'],
        ['options.limitHistory', impSettings.options.limitHistory, 'boolean'],
        ['options.protectKBFingerprint.enabled', impSettings.options.protectKBFingerprint.enabled, 'boolean'],
        ['options.protectKBFingerprint.delay', impSettings.options.protectKBFingerprint.delay, 'number'],
        ['options.protectWinName', impSettings.options.protectWinName, 'boolean'],
        ['options.resistFingerprinting', impSettings.options.resistFingerprinting, 'boolean'],
        ['options.spoofAudioContext', impSettings.options.spoofAudioContext, 'boolean'],
        ['options.spoofClientRects', impSettings.options.spoofClientRects, 'boolean'],
        ['options.spoofFontFingerprint', impSettings.options.spoofFontFingerprint, 'boolean'],
        [
          'options.screenSize',
          impSettings.options.screenSize,
          ['default', 'profile', '1366x768', '1440x900', '1600x900', '1920x1080', '1920x1200', '2560x1440', '2560x1600', '3840x2160', '4096x2304', '5120x2880'],
        ],
        ['options.timeZone', impSettings.options.timeZone, timezoneIds.concat(['default', 'ip'])],
        ['options.cookieNotPersistent', impSettings.options.cookieNotPersistent, 'boolean'],
        ['options.cookiePolicy', impSettings.options.cookiePolicy, ['allow_all', 'allow_visited', 'reject_all', 'reject_third_party', 'reject_trackers']],
        ['options.trackingProtectionMode', impSettings.options.trackingProtectionMode, ['always', 'never', 'private_browsing']],
        [
          'options.webRTCPolicy',
          impSettings.options.webRTCPolicy,
          ['default', 'default_public_and_private_interfaces', 'default_public_interface_only', 'disable_non_proxied_udp'],
        ],
        ['options.webSockets', impSettings.options.webSockets, ['allow_all', 'block_3rd_party', 'block_all']],
      ];

      for (let i = 0; i < options.length; i++) {
        let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
        if (v.error) {
          return v;
        } else {
          let parts: string[] = options[i][0].split('.');
          let lastIndex: string = parts[parts.length - 1];
          let nSetting = parts.slice(0, -1).reduce((o, i) => o[i], s);
          let oSetting = parts.slice(0, -1).reduce((o, i) => o[i], impSettings);

          nSetting[lastIndex] = oSetting[lastIndex];
        }
      }
    }

    if (!impSettings.whitelist) {
      msg = this.localization['options.import.invalid.whitelist'];

      return {
        error: true,
        msg,
      };
    } else {
      let seen = new Set();
      let hasDupes: boolean = impSettings.whitelist.rules.some(r => {
        return seen.size === seen.add(r.id).size;
      });

      if (hasDupes) {
        msg = this.localization['options.import.invalid.whitelistDupe'];

        return {
          error: true,
          msg,
        };
      }

      let options = [
        ['whitelist.enabledContextMenu', impSettings.whitelist.enabledContextMenu, 'boolean'],
        ['whitelist.defaultProfile', impSettings.whitelist.defaultProfile, profileIds.concat(['none'])],
      ];

      for (let i = 0; i < options.length; i++) {
        let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
        if (v.error) {
          return v;
        } else {
          let parts: string[] = options[i][0].split('.');
          let lastIndex: string = parts[parts.length - 1];
          let nSetting = parts.slice(0, -1).reduce((o, i) => o[i], s);
          let oSetting = parts.slice(0, -1).reduce((o, i) => o[i], impSettings);

          nSetting[lastIndex] = oSetting[lastIndex];
        }
      }

      for (let i = 0; i < impSettings.whitelist.rules.length; i++) {
        let options = [
          ['whitelist.rules.lang', impSettings.whitelist.rules[i].lang, languageIds],
          ['whitelist.rules.profile', impSettings.whitelist.rules[i].profile, profileIds.concat(['default', 'none'])],
        ];

        for (let i = 0; i < options.length; i++) {
          let v = this.checkValidOption(options[i][0], options[i][1], options[i][2]);
          if (v.error) {
            return v;
          }
        }

        if (impSettings.whitelist.rules[i].name === '') {
          msg = this.localization['options.import.invalid.whitelistName'];

          return {
            error: true,
            msg,
          };
        }

        if (!this.REGEX_UUID.test(impSettings.whitelist.rules[i].id)) {
          msg = this.localization['options.import.invalid.whitelistId'];

          return {
            error: true,
            msg,
          };
        }

        if (impSettings.whitelist.rules[i].spoofIP && !util.isValidIP(impSettings.whitelist.rules[i].spoofIP)) {
          msg = this.localization['options.import.invalid.whitelistSpoofIP'];

          return {
            error: true,
            msg,
          };
        }

        // validate whitelist options
        let keys = Object.keys(impSettings.whitelist.rules[i].options);
        if (
          keys.length !== 4 ||
          !keys.includes('name') ||
          !keys.includes('ref') ||
          !keys.includes('tz') ||
          !keys.includes('ws') ||
          typeof impSettings.whitelist.rules[i].options.name != 'boolean' ||
          typeof impSettings.whitelist.rules[i].options.ref != 'boolean' ||
          typeof impSettings.whitelist.rules[i].options.tz != 'boolean' ||
          typeof impSettings.whitelist.rules[i].options.ws != 'boolean'
        ) {
          msg = this.localization['options.import.invalid.whitelistOpt'];

          return {
            error: true,
            msg,
          };
        }
      }

      s.whitelist = impSettings.whitelist;
    }

    setTimeout(async () => {
      await this.saveSettings(s);
      browser.runtime.reload();
    }, 2500);

    msg = this.localization['options.import.success'];

    return {
      error: false,
      msg,
    };
  }
}
