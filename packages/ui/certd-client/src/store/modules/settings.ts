import { defineStore } from "pinia";
import { Modal, notification, theme } from "ant-design-vue";
import * as _ from "lodash-es";
// @ts-ignore
import { LocalStorage } from "/src/utils/util.storage";

import * as basicApi from "/@/api/modules/api.basic";
import { HeaderMenus, PlusInfo, SiteEnv, SiteInfo, SuiteSetting, SysInstallInfo, SysPublicSetting } from "/@/api/modules/api.basic";
import { useUserStore } from "/@/store/modules/user";
import { mitter } from "/@/utils/util.mitt";
import { env } from "/@/utils/util.env";

export type ThemeToken = {
  token: {
    colorPrimary?: string;
  };
  algorithm: any;
};
export type ThemeConfig = {
  colorPrimary: string;
  mode: string;
};
export interface SettingState {
  themeConfig?: ThemeConfig;
  themeToken: ThemeToken;
  sysPublic?: SysPublicSetting;
  installInfo?: {
    siteId: string;
    installTime?: number;
    bindUserId?: number;
    bindUrl?: string;
    accountServerBaseUrl?: string;
    appKey?: string;
  };
  siteInfo: SiteInfo;
  plusInfo?: PlusInfo;
  siteEnv?: SiteEnv;
  headerMenus?: HeaderMenus;
  inited?: boolean;
  suiteSetting?: SuiteSetting;
}

const defaultThemeConfig = {
  colorPrimary: "#1890ff",
  mode: "light"
};
const SETTING_THEME_KEY = "SETTING_THEME";
const defaultSiteInfo: SiteInfo = {
  title: env.TITLE || "Certd",
  slogan: env.SLOGAN || "让你的证书永不过期",
  logo: env.LOGO || "/static/images/logo/logo.svg",
  loginLogo: env.LOGIN_LOGO || "/static/images/logo/rect-block.svg",
  licenseTo: "",
  licenseToUrl: ""
};
export const useSettingStore = defineStore({
  id: "app.setting",
  state: (): SettingState => ({
    themeConfig: null,
    themeToken: {
      token: {},
      algorithm: theme.defaultAlgorithm
    },
    plusInfo: {
      isPlus: false,
      vipType: "free",
      isComm: false
    },
    sysPublic: {
      registerEnabled: false,
      managerOtherUserPipeline: false,
      icpNo: env.ICP_NO || ""
    },
    installInfo: {
      siteId: "",
      bindUserId: null,
      bindUrl: "",
      accountServerBaseUrl: "",
      appKey: ""
    },
    siteInfo: defaultSiteInfo,
    siteEnv: {
      agent: {
        enabled: undefined,
        contactText: "",
        contactLink: ""
      }
    },
    headerMenus: {
      menus: []
    },
    suiteSetting: { enabled: false },
    inited: false
  }),
  getters: {
    getThemeConfig(): any {
      return this.themeConfig || _.merge({}, defaultThemeConfig, LocalStorage.get(SETTING_THEME_KEY) || {});
    },
    getSysPublic(): SysPublicSetting {
      return this.sysPublic;
    },
    getInstallInfo(): SysInstallInfo {
      return this.installInfo;
    },
    isPlus(): boolean {
      return this.plusInfo?.isPlus && this.plusInfo?.expireTime > new Date().getTime();
    },
    isComm(): boolean {
      return this.plusInfo?.isComm && this.plusInfo?.expireTime > new Date().getTime();
    },
    isAgent(): boolean {
      return this.siteEnv?.agent?.enabled === true;
    },
    isCommOrAgent() {
      return this.isComm || this.isAgent;
    },
    vipLabel(): string {
      const vipLabelMap: any = {
        free: "基础版",
        plus: "专业版",
        comm: "商业版"
      };
      return vipLabelMap[this.plusInfo?.vipType || "free"];
    },
    getHeaderMenus(): { menus: any[] } {
      // @ts-ignore
      return this.headerMenus?.menus || { menus: [] };
    },
    isSuiteEnabled(): boolean {
      // @ts-ignore
      return this.suiteSetting?.enabled === true;
    }
  },
  actions: {
    checkPlus() {
      if (!this.isPlus) {
        notification.warn({
          message: "此为专业版功能，请先升级到专业版"
        });
        throw new Error("此为专业版功能，请升级到专业版");
      }
    },
    async loadSysSettings() {
      const allSettings = await basicApi.loadAllSettings();
      _.merge(this.sysPublic, allSettings.sysPublic || {});
      _.merge(this.installInfo, allSettings.installInfo || {});
      _.merge(this.siteEnv, allSettings.siteEnv || {});
      _.merge(this.plusInfo, allSettings.plusInfo || {});
      _.merge(this.headerMenus, allSettings.headerMenus || {});
      _.merge(this.suiteSetting, allSettings.suiteSetting || {});
      //@ts-ignore
      this.initSiteInfo(allSettings.siteInfo || {});
    },
    initSiteInfo(siteInfo: SiteInfo) {
      //@ts-ignore
      if (this.isComm) {
        if (siteInfo.logo) {
          siteInfo.logo = `/api/basic/file/download?key=${siteInfo.logo}`;
        }
        if (siteInfo.loginLogo) {
          siteInfo.loginLogo = `/api/basic/file/download?key=${siteInfo.loginLogo}`;
        }
      }
      this.siteInfo = _.merge({}, defaultSiteInfo, siteInfo);
    },
    async checkUrlBound() {
      const userStore = useUserStore();
      const settingStore = useSettingStore();
      if (!userStore.isAdmin) {
        return;
      }

      const bindUrl = this.installInfo.bindUrl;

      function getBaseUrl() {
        let url = window.location.href;
        //只要hash前面的部分
        url = url.split("#")[0];
        return url;
      }

      const doBindUrl = async (url: string) => {
        await basicApi.bindUrl({ url });
        await this.loadSysSettings();
      };

      const baseUrl = getBaseUrl();
      if (!bindUrl) {
        //绑定url
        await doBindUrl(baseUrl);
      } else {
        //检查当前url 是否与绑定的url一致
        const url = window.location.href;
        if (!url.startsWith(bindUrl)) {
          Modal.confirm({
            title: "URL地址有变化",
            content: "以后都用这个新地址访问本系统吗？",
            onOk: async () => {
              await doBindUrl(baseUrl);
            },
            okText: "是的，继续",
            cancelText: "不是，回到原来的地址",
            onCancel: () => {
              window.location.href = bindUrl;
            }
          });
        }
      }
    },
    persistThemeConfig() {
      LocalStorage.set(SETTING_THEME_KEY, this.getThemeConfig);
    },
    async setThemeConfig(themeConfig?: ThemeConfig) {
      this.themeConfig = _.merge({}, this.themeConfig, themeConfig);

      this.persistThemeConfig();
      this.setPrimaryColor(this.themeConfig.colorPrimary);
      this.setDarkMode(this.themeConfig.mode);
    },
    setPrimaryColor(color: any) {
      this.themeConfig.colorPrimary = color;
      _.set(this.themeToken, "token.colorPrimary", color);
      this.persistThemeConfig();
    },
    setDarkMode(mode: string) {
      this.themeConfig.mode = mode;
      if (mode === "dark") {
        this.themeToken.algorithm = theme.darkAlgorithm;
        // const defaultSeed = theme.defaultSeed;
        // const mapToken = theme.darkAlgorithm(defaultSeed);
        // less.modifyVars(mapToken);
        // less.modifyVars({
        //   "@colorPrimaryBg": "#111a2c",
        //   colorPrimaryBg: "#111a2c"
        // });
        // less.refreshStyles();
      } else {
        this.themeToken.algorithm = theme.defaultAlgorithm;

        // const defaultSeed = theme.defaultSeed;
        // const mapToken = theme.defaultAlgorithm(defaultSeed);
        // less.modifyVars(mapToken);
      }
      this.persistThemeConfig();
    },
    async init() {
      await this.setThemeConfig(this.getThemeConfig);
      await this.loadSysSettings();
    },
    async initOnce() {
      if (this.inited) {
        return;
      }
      await this.init();
      this.inited = true;
    }
  }
});

mitter.on("app.login", async () => {
  await useSettingStore().init();
});
