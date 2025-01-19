import { AbstractDnsProvider, CreateRecordOptions, IsDnsProvider, RemoveRecordOptions } from '@certd/plugin-cert';
import qs from 'qs';
import { NamesiloAccess } from './access.js';
import { merge } from 'lodash-es';

export type NamesiloRecord = {
  record_id: string;
};

// 这里通过IsDnsProvider注册一个dnsProvider
@IsDnsProvider({
  name: 'namesilo',
  title: 'namesilo',
  desc: 'namesilo dns provider',
  icon: 'simple-icons:namesilo',
  // 这里是对应的 cloudflare的access类型名称
  accessType: 'namesilo',
})
export class NamesiloDnsProvider extends AbstractDnsProvider<NamesiloRecord> {
  // 通过Autowire传递context
  access!: NamesiloAccess;
  async onInstance() {
    //一些初始化的操作
    // 也可以通过ctx成员变量传递context， 与Autowire效果一样
    this.access = this.ctx.access as NamesiloAccess;
  }

  private async doRequest(url: string, params: any = null) {
    params = merge(
      {
        version: 1,
        type: 'json',
        key: this.access.apiKey,
      },
      params
    );
    const qsString = qs.stringify(params);
    url = `${url}?${qsString}`;
    const res = await this.http.request<any, any>({
      url,
      baseURL: 'https://www.namesilo.com',
      method: 'get',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (res.reply?.code !== '300') {
      throw new Error(`${JSON.stringify(res.reply.detail)}`);
    }
    return res.reply;
  }

  /**
   * 创建dns解析记录，用于验证域名所有权
   */
  async createRecord(options: CreateRecordOptions): Promise<NamesiloRecord> {
    /**
     * fullRecord: '_acme-challenge.test.example.com',
     * value: 一串uuid
     * type: 'TXT',
     * domain: 'example.com'
     */
    const { fullRecord, hostRecord, value, type, domain } = options;
    this.logger.info('添加域名解析：', fullRecord, value, type, domain);

    //domain=namesilo.com&rrtype=A&rrhost=test&rrvalue=55.55.55.55&rrttl=7207
    const record: any = await this.doRequest('/api/dnsAddRecord', {
      domain,
      rrtype: type,
      rrhost: hostRecord,
      rrvalue: value,
      rrttl: 3600,
    });

    //本接口需要返回本次创建的dns解析记录，这个记录会在删除的时候用到
    return record;
  }

  /**
   *  删除dns解析记录,清理申请痕迹
   * @param options
   */
  async removeRecord(options: RemoveRecordOptions<NamesiloRecord>): Promise<void> {
    const { fullRecord, value } = options.recordReq;
    const record = options.recordRes;
    this.logger.info('删除域名解析：', fullRecord, value);
    if (!record && !record.record_id) {
      this.logger.info('record为空，不执行删除');
      return;
    }
    //这里调用删除txt dns解析记录接口

    const recordId = record.record_id;
    await this.doRequest('/api/dnsDeleteRecord', {
      domain: options.recordReq.domain,
      record_id: recordId,
    });
    this.logger.info(`删除域名解析成功:fullRecord=${fullRecord},value=${value}`);
  }
}

//实例化这个provider，将其自动注册到系统中
new NamesiloDnsProvider();
