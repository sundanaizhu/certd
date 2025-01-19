// @ts-ignore
import * as acme from "@certd/acme-client";
import { ClientExternalAccountBindingOptions, UrlMapping } from "@certd/acme-client";
import * as _ from "lodash-es";
import { Challenge } from "@certd/acme-client/types/rfc8555";
import { IContext } from "@certd/pipeline";
import { ILogger, utils } from "@certd/basic";
import { IDnsProvider, parseDomain } from "../../dns-provider/index.js";
import { HttpChallengeUploader } from "./uploads/api.js";
export type CnameVerifyPlan = {
  type?: string;
  domain: string;
  fullRecord: string;
  dnsProvider: IDnsProvider;
};

export type HttpVerifyPlan = {
  type: string;
  domain: string;
  httpUploader: HttpChallengeUploader;
};

export type DomainVerifyPlan = {
  domain: string;
  type: "cname" | "dns" | "http";
  dnsProvider?: IDnsProvider;
  cnameVerifyPlan?: Record<string, CnameVerifyPlan>;
  httpVerifyPlan?: Record<string, HttpVerifyPlan>;
};
export type DomainsVerifyPlan = {
  [key: string]: DomainVerifyPlan;
};

export type Providers = {
  dnsProvider?: IDnsProvider;
  domainsVerifyPlan?: DomainsVerifyPlan;
  httpUploader?: HttpChallengeUploader;
};

export type CertInfo = {
  crt: string; //fullchain证书
  key: string; //私钥
  csr: string; //csr
  oc?: string; //仅证书，非fullchain证书
  ic?: string; //中间证书
  pfx?: string;
  der?: string;
  jks?: string;
  one?: string;
};
export type SSLProvider = "letsencrypt" | "google" | "zerossl";
export type PrivateKeyType = "rsa_1024" | "rsa_2048" | "rsa_3072" | "rsa_4096" | "ec_256" | "ec_384" | "ec_521";
type AcmeServiceOptions = {
  userContext: IContext;
  logger: ILogger;
  sslProvider: SSLProvider;
  eab?: ClientExternalAccountBindingOptions;
  skipLocalVerify?: boolean;
  useMappingProxy?: boolean;
  reverseProxy?: string;
  privateKeyType?: PrivateKeyType;
  signal?: AbortSignal;
};

export class AcmeService {
  options: AcmeServiceOptions;
  userContext: IContext;
  logger: ILogger;
  sslProvider: SSLProvider;
  skipLocalVerify = true;
  eab?: ClientExternalAccountBindingOptions;
  constructor(options: AcmeServiceOptions) {
    this.options = options;
    this.userContext = options.userContext;
    this.logger = options.logger;
    this.sslProvider = options.sslProvider || "letsencrypt";
    this.eab = options.eab;
    this.skipLocalVerify = options.skipLocalVerify ?? false;
    acme.setLogger((message: any, ...args: any[]) => {
      this.logger.info(message, ...args);
    });
  }

  async getAccountConfig(email: string, urlMapping: UrlMapping): Promise<any> {
    const conf = (await this.userContext.getObj(this.buildAccountKey(email))) || {};
    if (urlMapping && urlMapping.mappings) {
      for (const key in urlMapping.mappings) {
        if (Object.prototype.hasOwnProperty.call(urlMapping.mappings, key)) {
          const element = urlMapping.mappings[key];
          if (conf.accountUrl?.indexOf(element) > -1) {
            //如果用了代理url，要替换回去
            conf.accountUrl = conf.accountUrl.replace(element, key);
          }
        }
      }
    }
    return conf;
  }

  buildAccountKey(email: string) {
    return `acme.config.${this.sslProvider}.${email}`;
  }

  async saveAccountConfig(email: string, conf: any) {
    await this.userContext.setObj(this.buildAccountKey(email), conf);
  }

  async getAcmeClient(email: string, isTest = false): Promise<acme.Client> {
    const mappings = {};
    if (this.sslProvider === "letsencrypt") {
      mappings["acme-v02.api.letsencrypt.org"] = this.options.reverseProxy || "le.px.certd.handfree.work";
    } else if (this.sslProvider === "google") {
      mappings["dv.acme-v02.api.pki.goog"] = this.options.reverseProxy || "gg.px.certd.handfree.work";
    }
    const urlMapping: UrlMapping = {
      enabled: false,
      mappings,
    };
    const conf = await this.getAccountConfig(email, urlMapping);
    if (conf.key == null) {
      conf.key = await this.createNewKey();
      await this.saveAccountConfig(email, conf);
      this.logger.info(`创建新的Accountkey:${email}`);
    }
    let directoryUrl = "";
    if (isTest) {
      directoryUrl = acme.directory[this.sslProvider].staging;
    } else {
      directoryUrl = acme.directory[this.sslProvider].production;
    }
    if (this.options.useMappingProxy) {
      urlMapping.enabled = true;
    } else {
      //测试directory是否可以访问
      const isOk = await this.testDirectory(directoryUrl);
      if (!isOk) {
        this.logger.info("测试访问失败，自动使用代理");
        urlMapping.enabled = true;
      }
    }
    const client = new acme.Client({
      sslProvider: this.sslProvider,
      directoryUrl: directoryUrl,
      accountKey: conf.key,
      accountUrl: conf.accountUrl,
      externalAccountBinding: this.eab,
      backoffAttempts: 15,
      backoffMin: 5000,
      backoffMax: 10000,
      urlMapping,
      signal: this.options.signal,
    });

    if (conf.accountUrl == null) {
      const accountPayload = {
        termsOfServiceAgreed: true,
        contact: [`mailto:${email}`],
        externalAccountBinding: this.eab,
      };
      await client.createAccount(accountPayload);
      conf.accountUrl = client.getAccountUrl();
      await this.saveAccountConfig(email, conf);
    }
    return client;
  }

  async createNewKey() {
    const key = await acme.crypto.createPrivateKey(2048);
    return key.toString();
  }

  async challengeCreateFn(authz: any, keyAuthorizationGetter: (challenge: Challenge) => Promise<string>, providers: Providers) {
    this.logger.info("Triggered challengeCreateFn()");

    const fullDomain = authz.identifier.value;
    let domain = parseDomain(fullDomain);
    this.logger.info("主域名为：" + domain);

    const getChallenge = (type: string) => {
      return authz.challenges.find((c: any) => c.type === type);
    };

    const doHttpVerify = async (challenge: any, httpUploader: HttpChallengeUploader) => {
      const keyAuthorization = await keyAuthorizationGetter(challenge);
      this.logger.info("http校验");
      const filePath = `.well-known/acme-challenge/${challenge.token}`;
      const fileContents = keyAuthorization;
      this.logger.info(`校验 ${fullDomain} ，准备上传文件：${filePath}`);
      await httpUploader.upload(filePath, Buffer.from(fileContents));
      this.logger.info(`上传文件【${filePath}】成功`);
      return {
        challenge,
        keyAuthorization,
        httpUploader,
      };
    };

    const doDnsVerify = async (challenge: any, fullRecord: string, dnsProvider: IDnsProvider) => {
      this.logger.info("dns校验");
      const keyAuthorization = await keyAuthorizationGetter(challenge);

      const recordValue = keyAuthorization;
      let hostRecord = fullRecord.replace(`${domain}`, "");
      if (hostRecord.endsWith(".")) {
        hostRecord = hostRecord.substring(0, hostRecord.length - 1);
      }

      const recordReq = {
        domain,
        fullRecord,
        hostRecord,
        type: "TXT",
        value: recordValue,
      };
      this.logger.info("添加 TXT 解析记录", JSON.stringify(recordReq));
      const recordRes = await dnsProvider.createRecord(recordReq);
      this.logger.info("添加 TXT 解析记录成功", JSON.stringify(recordRes));
      return {
        recordReq,
        recordRes,
        dnsProvider,
        challenge,
        keyAuthorization,
      };
    };

    let dnsProvider = providers.dnsProvider;
    let fullRecord = `_acme-challenge.${fullDomain}`;

    if (providers.domainsVerifyPlan) {
      //按照计划执行
      const domainVerifyPlan = providers.domainsVerifyPlan[domain];
      if (domainVerifyPlan) {
        if (domainVerifyPlan.type === "dns") {
          dnsProvider = domainVerifyPlan.dnsProvider;
        } else if (domainVerifyPlan.type === "cname") {
          const cnameVerifyPlan = domainVerifyPlan.cnameVerifyPlan;
          if (cnameVerifyPlan) {
            const cname = cnameVerifyPlan[fullDomain];
            if (cname) {
              dnsProvider = cname.dnsProvider;
              domain = parseDomain(cname.domain);
              fullRecord = cname.fullRecord;
            }
          } else {
            this.logger.error("未找到域名Cname校验计划，使用默认的dnsProvider");
          }
        } else if (domainVerifyPlan.type === "http") {
          const httpVerifyPlan = domainVerifyPlan.httpVerifyPlan;
          if (httpVerifyPlan) {
            const httpChallenge = getChallenge("http-01");
            if (httpChallenge == null) {
              throw new Error("该域名不支持http-01方式校验");
            }
            const plan = httpVerifyPlan[fullDomain];
            return await doHttpVerify(httpChallenge, plan.httpUploader);
          } else {
            throw new Error("未找到域名【" + fullDomain + "】的http校验配置");
          }
        } else {
          throw new Error("不支持的校验类型", domainVerifyPlan.type);
        }
      } else {
        this.logger.info("未找到域名校验计划，使用默认的dnsProvider");
      }
    }

    const dnsChallenge = getChallenge("dns-01");
    return await doDnsVerify(dnsChallenge, fullRecord, dnsProvider);
  }

  /**
   * Function used to remove an ACME challenge response
   *
   * @param {object} authz Authorization object
   * @param {object} challenge Selected challenge
   * @param {string} keyAuthorization Authorization key
   * @param recordReq
   * @param recordRes
   * @param dnsProvider dnsProvider
   * @param httpUploader
   * @returns {Promise}
   */

  async challengeRemoveFn(
    authz: any,
    challenge: any,
    keyAuthorization: string,
    recordReq: any,
    recordRes: any,
    dnsProvider?: IDnsProvider,
    httpUploader?: HttpChallengeUploader
  ) {
    this.logger.info("执行清理");

    /* http-01 */
    const fullDomain = authz.identifier.value;
    if (challenge.type === "http-01") {
      const filePath = `.well-known/acme-challenge/${challenge.token}`;
      this.logger.info(`Removing challenge response for ${fullDomain} at file: ${filePath}`);
      await httpUploader.remove(filePath);
      this.logger.info(`删除文件【${filePath}】成功`);
    } else if (challenge.type === "dns-01") {
      this.logger.info(`删除 TXT 解析记录:${JSON.stringify(recordReq)} ,recordRes = ${JSON.stringify(recordRes)}`);
      try {
        await dnsProvider.removeRecord({
          recordReq,
          recordRes,
        });
        this.logger.info("删除解析记录成功");
      } catch (e) {
        this.logger.error("删除解析记录出错：", e);
        throw e;
      }
    }
  }

  async order(options: {
    email: string;
    domains: string | string[];
    dnsProvider?: any;
    domainsVerifyPlan?: DomainsVerifyPlan;
    httpUploader?: any;
    csrInfo: any;
    isTest?: boolean;
    privateKeyType?: string;
  }): Promise<CertInfo> {
    const { email, isTest, domains, csrInfo, dnsProvider, domainsVerifyPlan, httpUploader } = options;
    const client: acme.Client = await this.getAcmeClient(email, isTest);

    /* Create CSR */
    const { commonName, altNames } = this.buildCommonNameByDomains(domains);
    let privateKey = null;
    const privateKeyType = options.privateKeyType || "rsa_2048";
    const privateKeyArr = privateKeyType.split("_");
    const type = privateKeyArr[0];
    let size = 2048;
    if (privateKeyArr.length > 1) {
      size = parseInt(privateKeyArr[1]);
    }

    let encodingType = "pkcs8";
    if (privateKeyArr.length > 2) {
      encodingType = privateKeyArr[2];
    }

    if (type == "ec") {
      const name: any = "P-" + size;
      privateKey = await acme.crypto.createPrivateEcdsaKey(name, encodingType);
    } else {
      privateKey = await acme.crypto.createPrivateRsaKey(size, encodingType);
    }

    let createCsr: any = acme.crypto.createCsr;
    if (encodingType === "pkcs1") {
      //兼容老版本
      createCsr = acme.forge.createCsr;
    }
    const [key, csr] = await createCsr(
      {
        commonName,
        ...csrInfo,
        altNames,
      },
      privateKey
    );

    if (dnsProvider == null && domainsVerifyPlan == null && httpUploader == null) {
      throw new Error("dnsProvider 、 domainsVerifyPlan 、 httpUploader不能都为空");
    }

    const providers: Providers = {
      dnsProvider,
      domainsVerifyPlan,
      httpUploader,
    };
    /* 自动申请证书 */
    const crt = await client.auto({
      csr,
      email: email,
      termsOfServiceAgreed: true,
      skipChallengeVerification: this.skipLocalVerify,
      challengePriority: ["dns-01", "http-01"],
      challengeCreateFn: async (
        authz: acme.Authorization,
        keyAuthorizationGetter: (challenge: Challenge) => Promise<string>
      ): Promise<{ recordReq?: any; recordRes?: any; dnsProvider?: any; challenge: Challenge; keyAuthorization: string }> => {
        return await this.challengeCreateFn(authz, keyAuthorizationGetter, providers);
      },
      challengeRemoveFn: async (
        authz: acme.Authorization,
        challenge: Challenge,
        keyAuthorization: string,
        recordReq: any,
        recordRes: any,
        dnsProvider: IDnsProvider
      ): Promise<any> => {
        return await this.challengeRemoveFn(authz, challenge, keyAuthorization, recordReq, recordRes, dnsProvider, httpUploader);
      },
      signal: this.options.signal,
    });

    const crtString = crt.toString();
    const cert: CertInfo = {
      crt: crtString,
      key: key.toString(),
      csr: csr.toString(),
    };
    /* Done */
    this.logger.debug(`CSR:\n${cert.csr}`);
    this.logger.debug(`Certificate:\n${cert.crt}`);
    this.logger.info("证书申请成功");
    return cert;
  }

  buildCommonNameByDomains(domains: string | string[]): {
    commonName: string;
    altNames: string[] | undefined;
  } {
    if (typeof domains === "string") {
      domains = domains.split(",");
    }
    if (domains.length === 0) {
      throw new Error("domain can not be empty");
    }
    const commonName = domains[0];
    let altNames: undefined | string[] = undefined;
    if (domains.length > 1) {
      altNames = _.slice(domains, 1);
    }
    return {
      commonName,
      altNames,
    };
  }

  private async testDirectory(directoryUrl: string) {
    try {
      await utils.http.request({
        url: directoryUrl,
        method: "GET",
        timeout: 10000,
      });
    } catch (e) {
      this.logger.error(`${directoryUrl}，测试访问失败`, e.message);
      return false;
    }
    this.logger.info(`${directoryUrl}，测试访问成功`);
    return true;
  }
}
