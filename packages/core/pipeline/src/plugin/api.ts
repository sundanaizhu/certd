import { Registrable } from "../registry/index.js";
import { FileItem, FormItemProps, Pipeline, Runnable, Step } from "../dt/index.js";
import { FileStore } from "../core/file-store.js";
import { IAccessService } from "../access/index.js";
import { ICnameProxyService, IEmailService, IUrlService } from "../service/index.js";
import { CancelError, IContext, RunHistory, RunnableCollection } from "../core/index.js";
import { HttpRequestConfig, ILogger, logger, utils } from "@certd/basic";
import { HttpClient } from "@certd/basic";
import dayjs from "dayjs";
import { IPluginConfigService } from "../service/config.js";
import { upperFirst } from "lodash-es";
import { INotificationService } from "../notification/index.js";
import { TaskEmitter } from "../service/emit.js";

export type PluginRequestHandleReq<T = any> = {
  typeName: string;
  action: string;
  input: T;
  data: any;
};

export type UserInfo = {
  role: "admin" | "user";
  id: any;
};
export enum ContextScope {
  global,
  pipeline,
  runtime,
}

export type TaskOutputDefine = {
  title: string;
  value?: any;
  type?: string;
};

export type TaskInputDefine = {
  required?: boolean;
  isSys?: boolean;
} & FormItemProps;

export type PluginDefine = Registrable & {
  default?: any;
  group?: string;
  icon?: string;
  input?: {
    [key: string]: TaskInputDefine;
  };
  output?: {
    [key: string]: TaskOutputDefine;
  };

  autowire?: {
    [key: string]: any;
  };

  needPlus?: boolean;
};

export type ITaskPlugin = {
  onInstance(): Promise<void>;
  execute(): Promise<void | string>;
  onRequest(req: PluginRequestHandleReq<any>): Promise<any>;
  [key: string]: any;
};

export type TaskResult = {
  clearLastStatus?: boolean;
  files?: FileItem[];
  pipelineVars: Record<string, any>;
  pipelinePrivateVars?: Record<string, any>;
};
export type TaskInstanceContext = {
  //流水线定义
  pipeline: Pipeline;
  //运行时历史
  runtime: RunHistory;
  //步骤定义
  step: Step;
  //日志
  logger: ILogger;
  //当前步骤输入参数跟上一次执行比较是否有变化
  inputChanged: boolean;
  //授权获取服务
  accessService: IAccessService;
  //邮件服务
  emailService: IEmailService;
  //cname记录服务
  cnameProxyService: ICnameProxyService;
  //插件配置服务
  pluginConfigService: IPluginConfigService;
  //通知服务
  notificationService: INotificationService;
  //url构建
  urlService: IUrlService;
  //流水线上下文
  pipelineContext: IContext;
  //用户上下文
  userContext: IContext;
  //http请求客户端
  http: HttpClient;
  //下载文件方法
  download: (config: HttpRequestConfig, savePath: string) => Promise<void>;
  //文件存储
  fileStore: FileStore;
  //上一次执行结果状态
  lastStatus?: Runnable;
  //用户取消信号
  signal: AbortSignal;
  //工具类
  utils: typeof utils;
  //用户信息
  user: UserInfo;

  emitter: TaskEmitter;
};

export abstract class AbstractTaskPlugin implements ITaskPlugin {
  _result: TaskResult = { clearLastStatus: false, files: [], pipelineVars: {}, pipelinePrivateVars: {} };
  ctx!: TaskInstanceContext;
  logger!: ILogger;
  http!: HttpClient;
  accessService!: IAccessService;

  clearLastStatus() {
    this._result.clearLastStatus = true;
  }

  getFiles() {
    return this._result.files;
  }

  checkSignal() {
    if (this.ctx.signal && this.ctx.signal.aborted) {
      throw new CancelError("用户取消");
    }
  }

  setCtx(ctx: TaskInstanceContext) {
    this.ctx = ctx;
    this.logger = ctx.logger;
    this.accessService = ctx.accessService;
    this.http = ctx.http;
  }

  async getAccess<T = any>(accessId: string) {
    if (accessId == null) {
      throw new Error("您还没有配置授权");
    }
    const res = await this.ctx.accessService.getById(accessId);
    if (res == null) {
      throw new Error("授权不存在，可能已被删除，请前往任务配置里面重新选择授权");
    }
    return res as T;
  }

  randomFileId() {
    return Math.random().toString(36).substring(2, 9);
  }
  saveFile(filename: string, file: Buffer) {
    const filePath = this.ctx.fileStore.writeFile(filename, file);
    logger.info(`saveFile:${filePath}`);
    this._result.files?.push({
      id: this.randomFileId(),
      filename,
      path: filePath,
    });
  }

  extendsFiles() {
    if (this._result.files == null) {
      this._result.files = [];
    }
    this._result.files.push(...(this.ctx.lastStatus?.status?.files || []));
  }

  get pipeline() {
    return this.ctx.pipeline;
  }

  get step() {
    return this.ctx.step;
  }

  async onInstance(): Promise<void> {
    return;
  }

  abstract execute(): Promise<void | string>;

  appendTimeSuffix(name?: string) {
    if (name == null) {
      name = "certd";
    }
    return name + "_" + dayjs().format("YYYYMMDDHHmmss");
  }

  async onRequest(req: PluginRequestHandleReq<any>) {
    if (!req.action) {
      throw new Error("action is required");
    }

    let methodName = req.action;
    if (!req.action.startsWith("on")) {
      methodName = `on${upperFirst(req.action)}`;
    }

    // @ts-ignore
    const method = this[methodName];
    if (method) {
      // @ts-ignore
      return await this[methodName](req.data);
    }
    throw new Error(`action ${req.action} not found`);
  }

  isAdmin() {
    return this.ctx.user.role === "admin";
  }

  getStepFromPipeline(stepId: string) {
    let found: any = null;
    RunnableCollection.each(this.ctx.pipeline.stages, (step) => {
      if (step.id === stepId) {
        found = step;
        return;
      }
    });
    return found;
  }

  getStepIdFromRefInput(ref = ".") {
    return ref.split(".")[1];
  }
}

export type OutputVO = {
  key: string;
  title: string;
  value: any;
};
