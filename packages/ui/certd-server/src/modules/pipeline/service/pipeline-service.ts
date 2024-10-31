import { Config, Inject, Provide, Scope, ScopeEnum, sleep } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { BaseService, NeedVIPException, PageReq, SysPublicSettings, SysSettingsService } from '@certd/lib-server';
import { PipelineEntity } from '../entity/pipeline.js';
import { PipelineDetail } from '../entity/vo/pipeline-detail.js';
import { Executor, isPlus, logger, Pipeline, ResultType, RunHistory, UserInfo } from '@certd/pipeline';
import { AccessService } from './access-service.js';
import { DbStorage } from './db-storage.js';
import { StorageService } from './storage-service.js';
import { Cron } from '../../cron/cron.js';
import { HistoryService } from './history-service.js';
import { HistoryEntity } from '../entity/history.js';
import { HistoryLogEntity } from '../entity/history-log.js';
import { HistoryLogService } from './history-log-service.js';
import { EmailService } from '../../basic/service/email-service.js';
import { UserService } from '../../sys/authority/service/user-service.js';
import { AccessGetter } from './access-getter.js';
import { CnameRecordService } from '../../cname/service/cname-record-service.js';
import { CnameProxyService } from './cname-proxy-service.js';
import { PluginConfigGetter } from '../../plugin/service/plugin-config-getter.js';
import dayjs from 'dayjs';

const runningTasks: Map<string | number, Executor> = new Map();
const freeCount = 10;

/**
 * 证书申请
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class PipelineService extends BaseService<PipelineEntity> {
  @InjectEntityModel(PipelineEntity)
  repository: Repository<PipelineEntity>;
  @Inject()
  emailService: EmailService;
  @Inject()
  accessService: AccessService;
  @Inject()
  cnameRecordService: CnameRecordService;
  @Inject()
  storageService: StorageService;
  @Inject()
  historyService: HistoryService;
  @Inject()
  historyLogService: HistoryLogService;

  @Inject()
  pluginConfigGetter: PluginConfigGetter;

  @Inject()
  sysSettingsService: SysSettingsService;

  @Inject()
  userService: UserService;

  @Inject()
  cron: Cron;

  @Config('certd')
  private certdConfig: any;

  //@ts-ignore
  getRepository() {
    return this.repository;
  }

  async add(bean: PipelineEntity) {
    await this.save(bean);
    return bean;
  }

  async page(pageReq: PageReq<PipelineEntity>) {
    const result = await super.page(pageReq);
    await this.fillLastVars(result.records);

    return result;
  }

  private async fillLastVars(records: PipelineEntity[]) {
    const pipelineIds: number[] = [];
    const recordMap = {};
    for (const record of records) {
      pipelineIds.push(record.id);
      recordMap[record.id] = record;
      record.title = record.title + '';
    }
    if (pipelineIds?.length > 0) {
      const vars = await this.storageService.findPipelineVars(pipelineIds);
      for (const varEntity of vars) {
        const record = recordMap[varEntity.namespace];
        if (record) {
          const value = JSON.parse(varEntity.value);
          record.lastVars = value.value;
        }
      }
    }
  }

  public async registerTriggerById(pipelineId) {
    if (pipelineId == null) {
      return;
    }
    const info = await this.info(pipelineId);
    if (info && !info.disabled) {
      const pipeline = JSON.parse(info.content);
      // 手动触发，不要await
      this.registerTriggers(pipeline);
    }
  }

  /**
   * 获取详情
   * @param id
   */
  async detail(id) {
    const pipeline = await this.info(id);
    return new PipelineDetail(pipeline);
  }

  async update(bean: PipelineEntity) {
    //更新非trigger部分
    await super.update(bean);
  }

  async save(bean: PipelineEntity) {
    let old = null;
    if (bean.id > 0) {
      //修改
      old = await this.info(bean.id);
    }
    const isUpdate = bean.id > 0 && old != null;
    if (!isUpdate) {
      //如果是添加，校验数量
      if (!isPlus()) {
        const count = await this.repository.count();
        if (count >= freeCount) {
          throw new NeedVIPException(`基础版最多只能创建${freeCount}条流水线`);
        }
      }
      const userId = bean.userId;
      const userIsAdmin = await this.userService.isAdmin(userId);
      if (!userIsAdmin) {
        //非管理员用户，限制pipeline数量
        const count = await this.repository.count({ where: { userId } });
        const sysPublic = await this.sysSettingsService.getSetting<SysPublicSettings>(SysPublicSettings);
        const limitUserPipelineCount = sysPublic.limitUserPipelineCount;
        if (limitUserPipelineCount && limitUserPipelineCount > 0 && count >= limitUserPipelineCount) {
          throw new NeedVIPException(`您最多只能创建${limitUserPipelineCount}条流水线`);
        }
      }
    }

    if (!isUpdate) {
      //如果是添加，先保存一下，获取到id，更新pipeline.id
      await this.addOrUpdate(bean);
    }
    await this.clearTriggers(bean.id);
    if (bean.content) {
      const pipeline = JSON.parse(bean.content);
      if (pipeline.title) {
        bean.title = pipeline.title;
      }
      pipeline.id = bean.id;
      bean.content = JSON.stringify(pipeline);
    }
    await this.addOrUpdate(bean);
    await this.registerTriggerById(bean.id);
    return bean;
  }

  async foreachPipeline(callback: (pipeline: PipelineEntity) => void) {
    const idEntityList = await this.repository.find({
      select: {
        id: true,
      },
      where: {
        disabled: false,
      },
    });
    const ids = idEntityList.map(item => {
      return item.id;
    });

    //id 分段
    const idsSpan = [];
    let arr = [];
    for (let i = 0; i < ids.length; i++) {
      if (i % 20 === 0) {
        arr = [];
        idsSpan.push(arr);
      }
      arr.push(ids[i]);
    }

    //分段加载记录
    for (const idArr of idsSpan) {
      const list = await this.repository.findBy({
        id: In(idArr),
      });

      for (const entity of list) {
        await callback(entity);
      }
    }
  }

  async stopOtherUserPipeline(userId: number) {
    await this.foreachPipeline(async entity => {
      if (entity.userId !== userId) {
        await this.clearTriggers(entity.id);
      }
    });
  }

  /**
   * 应用启动后初始加载记录
   */
  async onStartup(immediateTriggerOnce: boolean, onlyAdminUser: boolean) {
    await this.foreachPipeline(async entity => {
      if (onlyAdminUser && entity.userId !== 1) {
        return;
      }
      const pipeline = JSON.parse(entity.content ?? '{}');
      try {
        await this.registerTriggers(pipeline, immediateTriggerOnce);
      } catch (e) {
        logger.error('加载定时trigger失败：', e);
      }
    });
    logger.info('定时器数量：', this.cron.getTaskSize());
  }

  async registerTriggers(pipeline?: Pipeline, immediateTriggerOnce = false) {
    if (pipeline?.triggers == null) {
      return;
    }
    for (const trigger of pipeline.triggers) {
      this.registerCron(pipeline.id, trigger);
    }

    if (immediateTriggerOnce) {
      await this.trigger(pipeline.id);
      await sleep(200);
    }
  }

  async trigger(id: any, stepId?: string) {
    this.cron.register({
      name: `pipeline.${id}.trigger.once`,
      cron: null,
      job: async () => {
        logger.info('用户手动启动job');
        try {
          await this.run(id, null, stepId);
        } catch (e) {
          logger.error('手动job执行失败：', e);
        }
      },
    });
  }

  async delete(id: any) {
    await this.clearTriggers(id);
    //TODO 删除storage
    // const storage = new DbStorage(pipeline.userId, this.storageService);
    // await storage.remove(pipeline.id);
    await super.delete([id]);
    await this.historyService.deleteByPipelineId(id);
    await this.historyLogService.deleteByPipelineId(id);
  }

  async clearTriggers(id: number) {
    if (id == null) {
      return;
    }
    const pipeline = await this.info(id);
    if (!pipeline) {
      return;
    }
    const pipelineObj = JSON.parse(pipeline.content);
    if (pipelineObj.triggers) {
      for (const trigger of pipelineObj.triggers) {
        this.removeCron(id, trigger);
      }
    }
  }

  removeCron(pipelineId, trigger) {
    const name = this.buildCronKey(pipelineId, trigger.id);
    this.cron.remove(name);
  }

  registerCron(pipelineId, trigger) {
    if (pipelineId == null) {
      logger.warn('pipelineId为空，无法注册定时任务');
      return;
    }

    let cron = trigger.props?.cron;
    if (cron == null) {
      return;
    }
    cron = cron.trim();
    if (cron.startsWith('*')) {
      cron = '0' + cron.substring(1, cron.length);
    }
    const triggerId = trigger.id;
    const name = this.buildCronKey(pipelineId, triggerId);
    this.cron.remove(name);
    this.cron.register({
      name,
      cron,
      job: async () => {
        logger.info('定时任务触发：', pipelineId, triggerId);
        if (pipelineId == null) {
          logger.warn('pipelineId为空,无法执行');
          return;
        }
        try {
          await this.run(pipelineId, triggerId);
        } catch (e) {
          logger.error('定时job执行失败：', e);
        }
      },
    });
    logger.info('当前定时器数量：', this.cron.getTaskSize());
  }

  async run(id: number, triggerId: string, stepId?: string) {
    const entity: PipelineEntity = await this.info(id);

    const pipeline = JSON.parse(entity.content);
    if (!pipeline.id) {
      pipeline.id = id;
    }

    if (!pipeline.stages || pipeline.stages.length === 0) {
      return;
    }

    const triggerType = this.getTriggerType(triggerId, pipeline);
    if (triggerType == null) {
      return;
    }

    if (triggerType === 'timer') {
      if (entity.disabled) {
        return;
      }
    }

    const onChanged = async (history: RunHistory) => {
      //保存执行历史
      try {
        logger.info('保存执行历史：', history.id);
        await this.saveHistory(history);
      } catch (e) {
        const pipelineEntity = new PipelineEntity();
        pipelineEntity.id = id;
        pipelineEntity.status = 'error';
        pipelineEntity.lastHistoryTime = history.pipeline.status.startTime;
        await this.update(pipelineEntity);
        logger.error('保存执行历史失败：', e);
        throw e;
      }
    };

    const userId = entity.userId;
    const historyId = await this.historyService.start(entity);
    const userIsAdmin = await this.userService.isAdmin(userId);
    const user: UserInfo = {
      id: userId,
      role: userIsAdmin ? 'admin' : 'user',
    };
    const accessGetter = new AccessGetter(userId, this.accessService.getById.bind(this.accessService));
    const cnameProxyService = new CnameProxyService(userId, this.cnameRecordService.getWithAccessByDomain.bind(this.cnameRecordService));
    const executor = new Executor({
      user,
      pipeline,
      onChanged,
      accessService: accessGetter,
      cnameProxyService,
      pluginConfigService: this.pluginConfigGetter,
      storage: new DbStorage(userId, this.storageService),
      emailService: this.emailService,
      fileRootDir: this.certdConfig.fileRootDir,
    });
    try {
      runningTasks.set(historyId, executor);
      await executor.init();
      if (stepId) {
        // 清除该step的状态
        executor.clearLastStatus(stepId);
      }
      await executor.run(historyId, triggerType);
    } catch (e) {
      logger.error('执行失败：', e);
      // throw e;
    } finally {
      runningTasks.delete(historyId);
    }
  }

  async cancel(historyId: number) {
    const executor = runningTasks.get(historyId);
    if (executor) {
      await executor.cancel();
    }
    const entity = await this.historyService.info(historyId);
    if (entity == null) {
      return;
    }
    const pipeline: Pipeline = JSON.parse(entity.pipeline);
    pipeline.status.status = ResultType.canceled;
    pipeline.status.result = ResultType.canceled;
    const runtime = new RunHistory(historyId, null, pipeline);
    await this.saveHistory(runtime);
  }

  private getTriggerType(triggerId, pipeline) {
    let triggerType = 'user';
    if (triggerId != null) {
      //如果不是手动触发
      //查找trigger
      const found = this.findTrigger(pipeline, triggerId);
      if (!found) {
        //如果没有找到triggerId，说明被用户删掉了，这里再删除一次
        this.cron.remove(this.buildCronKey(pipeline.id, triggerId));
        triggerType = null;
      } else {
        logger.info('timer trigger:' + found.id, found.title, found.cron);
        triggerType = 'timer';
      }
    }
    return triggerType;
  }

  private buildCronKey(pipelineId, triggerId) {
    return `pipeline.${pipelineId}.trigger.${triggerId}`;
  }

  private findTrigger(pipeline, triggerId) {
    for (const trigger of pipeline.triggers) {
      if (trigger.id === triggerId) {
        return trigger;
      }
    }
    return;
  }

  private async saveHistory(history: RunHistory) {
    //修改pipeline状态
    const pipelineEntity = new PipelineEntity();
    pipelineEntity.id = parseInt(history.pipeline.id);
    pipelineEntity.status = history.pipeline.status.status + '';
    pipelineEntity.lastHistoryTime = history.pipeline.status.startTime;
    await this.update(pipelineEntity);

    const entity: HistoryEntity = new HistoryEntity();
    entity.id = parseInt(history.id);
    entity.userId = history.pipeline.userId;
    entity.status = pipelineEntity.status;
    entity.pipeline = JSON.stringify(history.pipeline);
    entity.pipelineId = parseInt(history.pipeline.id);
    await this.historyService.save(entity);

    const logEntity: HistoryLogEntity = new HistoryLogEntity();
    logEntity.id = entity.id;
    logEntity.userId = entity.userId;
    logEntity.pipelineId = entity.pipelineId;
    logEntity.historyId = entity.id;
    logEntity.logs = JSON.stringify(history.logs);
    await this.historyLogService.addOrUpdate(logEntity);
  }

  async count(param: { userId?: any }) {
    const count = await this.repository.count({
      where: {
        userId: param.userId,
      },
    });
    return count;
  }

  async statusCount(param: { userId?: any } = {}) {
    const statusCount = await this.repository
      .createQueryBuilder()
      .select('status')
      .addSelect('count(1)', 'count')
      .where({
        userId: param.userId,
      })
      .groupBy('status')
      .getRawMany();
    return statusCount;
  }

  async latestExpiringList({ userId }: any) {
    let list = await this.repository.find({
      select: {
        id: true,
        title: true,
        status: true,
      },
      where: {
        userId,
      },
    });
    await this.fillLastVars(list);
    list = list.filter(item => {
      return item.lastVars?.certExpiresTime != null;
    });
    list = list.sort((a, b) => {
      return a.lastVars.certExpiresTime - b.lastVars.certExpiresTime;
    });

    return list.slice(0, 5);
  }

  async createCountPerDay(param: { days: number } = { days: 7 }) {
    const todayEnd = dayjs().endOf('day');
    const result = await this.getRepository()
      .createQueryBuilder('main')
      .select('date(main.createTime)  AS date') // 将UNIX时间戳转换为日期
      .addSelect('COUNT(*) AS count')
      .where({
        // 0点
        createTime: MoreThan(todayEnd.add(-param.days, 'day').toDate()),
      })
      .groupBy('date')
      .getRawMany();

    return result;
  }
}
