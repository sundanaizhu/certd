import { ILogger } from "@certd/basic";
import { AliyunAccess } from "../access/index.js";
import { AliyunClient } from "./index.js";

export type AliyunCertInfo = {
  crt: string; //fullchain证书
  key: string; //私钥
};
export type AliyunSslClientOpts = {
  access: AliyunAccess;
  logger: ILogger;
  endpoint: string;
};

export type AliyunSslGetResourceListReq = {
  cloudProduct: string;
};

export type AliyunSslCreateDeploymentJobReq = {
  name: string;
  jobType: string;
  contactIds: string[];
  resourceIds: string[];
  certIds: string[];
};

export type AliyunSslUploadCertReq = {
  name: string;
  cert: AliyunCertInfo;
};

export type CasCertInfo = { certId: number; certName: string; certIdentifier: string };

export class AliyunSslClient {
  opts: AliyunSslClientOpts;
  constructor(opts: AliyunSslClientOpts) {
    this.opts = opts;
  }

  checkRet(ret: any) {
    if (ret.Code != null) {
      throw new Error("执行失败：" + ret.Message);
    }
  }

  async getClient() {
    const access = this.opts.access;
    const client = new AliyunClient({ logger: this.opts.logger });
    await client.init({
      accessKeyId: access.accessKeyId,
      accessKeySecret: access.accessKeySecret,
      endpoint: `https://${this.opts.endpoint || "cas.aliyuncs.com"}`,
      apiVersion: "2020-04-07",
    });
    return client;
  }

  async getCertInfo(certId: number): Promise<CasCertInfo> {
    const client = await this.getClient();
    const params = {
      CertId: certId,
    };

    const res = await client.request("GetUserCertificateDetail", params);
    this.checkRet(res);

    return {
      certId: certId,
      certName: res.Name,
      certIdentifier: res.CertIdentifier,
    };
  }

  async uploadCert(req: AliyunSslUploadCertReq) {
    const client = await this.getClient();
    const params = {
      Name: req.name,
      Cert: req.cert.crt,
      Key: req.cert.key,
    };

    const requestOption = {
      method: "POST",
    };

    this.opts.logger.info("开始上传证书");
    const ret: any = await client.request("UploadUserCertificate", params, requestOption);
    this.checkRet(ret);
    this.opts.logger.info("证书上传成功：aliyunCertId=", ret.CertId);
    //output
    return ret.CertId;
  }

  async getResourceList(req: AliyunSslGetResourceListReq) {
    const client = await this.getClient();
    const params = {
      CloudName: "aliyun",
      CloudProduct: req.cloudProduct,
    };

    const requestOption = {
      method: "POST",
      formatParams: false,
    };

    const res = await client.request("ListCloudResources", params, requestOption);
    this.checkRet(res);
    return res;
  }

  async createDeploymentJob(req: AliyunSslCreateDeploymentJobReq) {
    const client = await this.getClient();

    const params = {
      Name: req.name,
      JobType: req.jobType,
      ContactIds: req.contactIds.join(","),
      ResourceIds: req.resourceIds.join(","),
      CertIds: req.certIds.join(","),
    };

    const requestOption = {
      method: "POST",
      formatParams: false,
    };

    const res = await client.request("CreateDeploymentJob", params, requestOption);
    this.checkRet(res);
    return res;
  }

  async getContactList() {
    const params = {};

    const requestOption = {
      method: "POST",
      formatParams: false,
    };
    const client = await this.getClient();
    const res = await client.request("ListContact", params, requestOption);
    this.checkRet(res);
    return res;
  }

  async doRequest(action: string, params: any, requestOption: any) {
    const client = await this.getClient();
    const res = await client.request(action, params, requestOption);
    this.checkRet(res);
    return res;
  }
}
