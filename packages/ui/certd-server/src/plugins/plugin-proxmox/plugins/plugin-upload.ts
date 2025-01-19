import { IsTaskPlugin, pluginGroups, RunStrategy, TaskInput } from '@certd/pipeline';
import { CertInfo } from '@certd/plugin-cert';
import { AbstractPlusTaskPlugin } from '@certd/plugin-plus';
import { ProxmoxAccess } from '../access.js';
import { createRemoteSelectInputDefine } from '@certd/plugin-lib';

@IsTaskPlugin({
  //命名规范，插件名称+功能（就是目录plugin-demo中的demo），大写字母开头，驼峰命名
  name: 'ProxmoxUploadCert',
  title: '上传证书到Proxmox',
  icon: 'clarity:plugin-line',
  //插件分组
  group: pluginGroups.other.key,
  needPlus: true,
  default: {
    //默认值配置照抄即可
    strategy: {
      runStrategy: RunStrategy.SkipWhenSucceed,
    },
  },
})
//类名规范，跟上面插件名称（name）一致
export class ProxmoxUploadCert extends AbstractPlusTaskPlugin {
  //证书选择，此项必须要有
  @TaskInput({
    title: '域名证书',
    helper: '请选择前置任务输出的域名证书',
    component: {
      name: 'output-selector',
      from: ['CertApply', 'CertApplyLego'],
    },
    // required: true, // 必填
  })
  cert!: CertInfo;

  // @TaskInput(createCertDomainGetterInputDefine({ props: { required: false } }))
  // //前端可以展示，当前申请的证书域名列表
  // certDomains!: string[];

  //授权选择框
  @TaskInput({
    title: 'Proxmox授权',
    component: {
      name: 'access-selector',
      type: 'proxmox', //固定授权类型
    },
    required: true, //必填
  })
  accessId!: string;
  //

  @TaskInput(
    createRemoteSelectInputDefine({
      title: '节点',
      helper: '要部署证书的节点',
      typeName: 'ProxmoxUploadCert',
      action: ProxmoxUploadCert.prototype.onGetNodeList.name,
      watches: ['accessId'],
    })
  )
  nodes!: string[];

  //插件实例化时执行的方法
  async onInstance() {}

  //插件执行方法
  async execute(): Promise<void> {
    const { cert } = this;

    const client = await this.getClient();

    for (const node of this.nodes) {
      this.logger.info(`开始上传证书到节点：${node}`);
      const res = await client.nodes.get(node).certificates.custom.uploadCustomCert(cert.crt, false, cert.key, true);
      this.logger.info(`上传结果：${JSON.stringify(res.response)}`);
    }

    this.logger.info('部署成功');
  }

  async onGetNodeList() {
    const client = await this.getClient();

    const nodesRes = await client.nodes.index();
    // this.logger.info('nodes:', nodesRes.response);
    return nodesRes.response.data.map((node: any) => {
      return {
        value: node.node,
        label: node.node,
      };
    });
  }

  async getClient() {
    const access: ProxmoxAccess = await this.accessService.getById<ProxmoxAccess>(this.accessId);
    const pve = await import('@corsinvest/cv4pve-api-javascript');
    const client = new pve.PveClient(access.host, access.port);
    const login = await client.login(access.username, access.password, 'pam');
    if (!login) {
      throw new Error(`Login failed:${JSON.stringify(login)}`);
    }
    const versionRes = await client.version.version();
    this.logger.info('Proxmox version:', versionRes.response);
    return client;
  }
}
//实例化一下，注册插件
new ProxmoxUploadCert();
