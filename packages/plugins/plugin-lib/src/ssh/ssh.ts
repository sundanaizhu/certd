// @ts-ignore
import ssh2, { ConnectConfig, ExecOptions } from "ssh2";
import path from "path";
import * as _ from "lodash-es";
import { ILogger } from "@certd/basic";
import { SshAccess } from "./ssh-access.js";
import stripAnsi from "strip-ansi";
import { SocksClient } from "socks";
import { SocksProxy, SocksProxyType } from "socks/typings/common/constants.js";
export type TransportItem = { localPath: string; remotePath: string };

export class AsyncSsh2Client {
  conn: ssh2.Client;
  logger: ILogger;
  connConf: SshAccess & ssh2.ConnectConfig;
  windows = false;
  encoding: string;
  constructor(connConf: SshAccess, logger: ILogger) {
    this.connConf = connConf;
    this.logger = logger;
    this.windows = connConf.windows || false;
    this.encoding = connConf.encoding;
  }

  convert(iconv: any, buffer: Buffer) {
    if (this.encoding) {
      return iconv.decode(buffer, this.encoding);
    }
    return buffer.toString().replaceAll("\r\n", "\n");
  }

  async connect() {
    this.logger.info(`开始连接，${this.connConf.host}:${this.connConf.port}`);
    if (this.connConf.socksProxy) {
      this.logger.info(`使用代理${this.connConf.socksProxy}`);
      if (typeof this.connConf.port === "string") {
        this.connConf.port = parseInt(this.connConf.port);
      }
      const proxyOption: SocksProxy = this.parseSocksProxyFromUri(this.connConf.socksProxy);
      const info = await SocksClient.createConnection({
        proxy: proxyOption,
        command: "connect",
        destination: {
          host: this.connConf.host,
          port: this.connConf.port,
        },
      });
      this.logger.info("代理连接成功");
      this.connConf.sock = info.socket;
    }
    return new Promise((resolve, reject) => {
      try {
        const conn = new ssh2.Client();
        conn
          .on("error", (err: any) => {
            this.logger.error("连接失败", err);
            reject(err);
          })
          .on("ready", () => {
            this.logger.info("连接成功");
            this.conn = conn;
            resolve(this.conn);
          })
          .connect(this.connConf);
      } catch (e) {
        reject(e);
      }
    });
  }
  async getSftp() {
    return new Promise((resolve, reject) => {
      this.logger.info("获取sftp");
      this.conn.sftp((err: any, sftp: any) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(sftp);
      });
    });
  }

  async fastPut(options: { sftp: any; localPath: string; remotePath: string }) {
    const { sftp, localPath, remotePath } = options;
    return new Promise((resolve, reject) => {
      this.logger.info(`开始上传：${localPath} => ${remotePath}`);
      sftp.fastPut(localPath, remotePath, (err: Error) => {
        if (err) {
          reject(err);
          this.logger.error("请确认路径是否包含文件名，路径本身不能是目录，路径不能有*?之类的特殊符号，要有写入权限");
          return;
        }
        this.logger.info(`上传文件成功：${localPath} => ${remotePath}`);
        resolve({});
      });
    });
  }

  async unlink(options: { sftp: any; remotePath: string }) {
    const { sftp, remotePath } = options;
    return new Promise((resolve, reject) => {
      this.logger.info(`开始删除远程文件：${remotePath}`);
      sftp.unlink(remotePath, (err: Error) => {
        if (err) {
          reject(err);
          return;
        }
        this.logger.info(`删除文件成功：${remotePath}`);
        resolve({});
      });
    });
  }

  async exec(
    script: string,
    opts: {
      throwOnStdErr?: boolean;
    } = {}
  ): Promise<string> {
    if (!script) {
      this.logger.info("script 为空，取消执行");
      return;
    }
    let iconv: any = await import("iconv-lite");
    iconv = iconv.default;
    // if (this.connConf.windows) {
    //   script += "\r\nexit\r\n";
    //   //保证windows下正常退出
    // }
    return new Promise((resolve, reject) => {
      this.logger.info(`执行命令：[${this.connConf.host}][exec]: \n` + script);
      this.conn.exec(script, (err: Error, stream: any) => {
        if (err) {
          reject(err);
          return;
        }
        let data = "";
        let hasErrorLog = false;
        stream
          .on("close", (code: any, signal: any) => {
            this.logger.info(`[${this.connConf.host}][close]:code:${code}`);
            if (opts.throwOnStdErr == null && this.windows) {
              opts.throwOnStdErr = true;
            }
            if (opts.throwOnStdErr && hasErrorLog) {
              reject(new Error(data));
            }

            if (code === 0) {
              resolve(data);
            } else {
              reject(new Error(data));
            }
          })
          .on("data", (ret: Buffer) => {
            const out = this.convert(iconv, ret);
            data += out;
            this.logger.info(`[${this.connConf.host}][info]: ` + out.trimEnd());
          })
          .on("error", (err: any) => {
            reject(err);
            this.logger.error(err);
          })
          .stderr.on("data", (ret: Buffer) => {
            const err = this.convert(iconv, ret);
            data += err;
            hasErrorLog = true;
            this.logger.error(`[${this.connConf.host}][error]: ` + err.trimEnd());
          });
      });
    });
  }

  async shell(script: string | string[]): Promise<string> {
    return new Promise<any>((resolve, reject) => {
      this.logger.info(`执行shell脚本：[${this.connConf.host}][shell]: ` + script);
      this.conn.shell((err: Error, stream: any) => {
        if (err) {
          reject(err);
          return;
        }
        let output = "";
        function ansiHandle(data: string) {
          data = data.replace(/\[[0-9]+;1H/g, "");
          data = stripAnsi(data);
          return data.replaceAll("\r\n", "\n");
        }
        stream
          .on("close", (code: any) => {
            this.logger.info("Stream :: close,code: " + code);
            resolve(output);
          })
          .on("data", (ret: Buffer) => {
            const data = ansiHandle(ret.toString());
            this.logger.info(data);
            output += data;
          })
          .on("error", (err: any) => {
            reject(err);
            this.logger.error(err);
          })
          .stderr.on("data", (ret: Buffer) => {
            const data = ansiHandle(ret.toString());
            output += data;
            this.logger.error(`[${this.connConf.host}][error]: ` + data);
          });
        //保证windows下正常退出
        const exit = "\r\nexit\r\n";
        stream.end(script + exit);
      });
    });
  }
  end() {
    if (this.conn) {
      this.conn.end();
      this.conn.destroy();
      this.conn = null;
    }
  }

  private parseSocksProxyFromUri(socksProxyUri: string): SocksProxy {
    const url = new URL(socksProxyUri);
    let type: SocksProxyType = 5;
    if (url.protocol.startsWith("socks4")) {
      type = 4;
    }
    const proxy: SocksProxy = {
      host: url.hostname,
      port: parseInt(url.port),
      type,
    };
    if (url.username) {
      proxy.userId = url.username;
    }
    if (url.password) {
      proxy.password = url.password;
    }
    return proxy;
  }
}

export class SshClient {
  logger: ILogger;
  constructor(logger: ILogger) {
    this.logger = logger;
  }
  /**
   *
   * @param connectConf
    {
          host: '192.168.100.100',
          port: 22,
          username: 'frylock',
          password: 'nodejsrules'
         }
   * @param options
   */
  async uploadFiles(options: { connectConf: SshAccess; transports: TransportItem[]; mkdirs: boolean }) {
    const { connectConf, transports, mkdirs } = options;
    await this._call({
      connectConf,
      callable: async (conn: AsyncSsh2Client) => {
        const sftp = await conn.getSftp();
        this.logger.info("开始上传");
        for (const transport of transports) {
          if (mkdirs !== false) {
            const filePath = path.dirname(transport.remotePath);
            let mkdirCmd = `mkdir -p ${filePath} `;
            if (conn.windows) {
              if (filePath.indexOf("/") > -1) {
                this.logger.info("--------------------------");
                this.logger.info("请注意：windows下，文件目录分隔应该写成\\而不是/");
                this.logger.info("--------------------------");
              }
              const isCmd = await this.isCmd(conn);
              if (!isCmd) {
                mkdirCmd = `New-Item -ItemType Directory -Path "${filePath}" -Force`;
              } else {
                mkdirCmd = `if not exist "${filePath}" mkdir "${filePath}"`;
              }
            }
            await conn.exec(mkdirCmd);
          }
          await conn.fastPut({ sftp, ...transport });
        }
        this.logger.info("文件全部上传成功");
      },
    });
  }

  async removeFiles(opts: { connectConf: SshAccess; files: string[] }) {
    const { connectConf, files } = opts;
    await this._call({
      connectConf,
      callable: async (conn: AsyncSsh2Client) => {
        const sftp = await conn.getSftp();
        this.logger.info("开始删除");
        for (const file of files) {
          await conn.unlink({
            sftp,
            remotePath: file,
          });
        }
        this.logger.info("文件全部删除成功");
      },
    });
  }

  async isCmd(conn: AsyncSsh2Client) {
    const spec = await conn.exec("echo %COMSPEC% ");
    if (spec.toString().trim() === "%COMSPEC%") {
      return false;
    } else {
      return true;
    }
  }

  async getIsCmd(options: { connectConf: SshAccess }) {
    const { connectConf } = options;
    return await this._call<boolean>({
      connectConf,
      callable: async (conn: AsyncSsh2Client) => {
        return await this.isCmd(conn);
      },
    });
  }

  /**
   *
   * Set-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
   * Start-Service sshd
   *
   * Set-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\cmd.exe"
   * @param options
   */
  async exec(options: { connectConf: SshAccess; script: string | Array<string>; env?: any }): Promise<string> {
    let { script } = options;
    const { connectConf } = options;

    // this.logger.info('命令：', script);
    return await this._call({
      connectConf,
      callable: async (conn: AsyncSsh2Client) => {
        let isWinCmd = false;
        const isLinux = !connectConf.windows;
        const envScripts = [];
        if (connectConf.windows) {
          isWinCmd = await this.isCmd(conn);
        }

        if (options.env) {
          for (const key in options.env) {
            if (isLinux) {
              envScripts.push(`export ${key}=${options.env[key]}`);
            } else if (isWinCmd) {
              //win cmd
              envScripts.push(`set ${key}=${options.env[key]}`);
            } else {
              //powershell
              envScripts.push(`$env:${key}="${options.env[key]}"`);
            }
          }
        }

        if (isWinCmd) {
          //组合成&&的形式
          if (typeof script === "string") {
            script = script.split("\n");
          }
          script = envScripts.concat(script);
          script = script as Array<string>;
          script = script.join(" && ");
        } else {
          const newLine = isLinux ? "\n" : "\r\n";
          if (_.isArray(script)) {
            script = script as Array<string>;
            script = script.join(newLine);
          }
          if (envScripts.length > 0) {
            script = envScripts.join(newLine) + newLine + script;
          }
        }
        return await conn.exec(script as string);
      },
    });
  }

  async shell(options: { connectConf: SshAccess; script: string | Array<string> }): Promise<string> {
    let { script } = options;
    const { connectConf } = options;
    if (_.isArray(script)) {
      script = script as Array<string>;
      if (connectConf.windows) {
        script = script.join("\r\n");
      } else {
        script = script.join("\n");
      }
    } else {
      if (connectConf.windows) {
        //@ts-ignore
        script = script.replaceAll("\n", "\r\n");
      }
    }
    return await this._call({
      connectConf,
      callable: async (conn: AsyncSsh2Client) => {
        return await conn.shell(script as string);
      },
    });
  }

  async _call<T = any>(options: { connectConf: SshAccess; callable: (conn: AsyncSsh2Client) => Promise<T> }): Promise<T> {
    const { connectConf, callable } = options;
    const conn = new AsyncSsh2Client(connectConf, this.logger);
    try {
      await conn.connect();
    } catch (e: any) {
      if (e.message?.indexOf("All configured authentication methods failed") > -1) {
        this.logger.error(e);
        throw new Error("登录失败，请检查用户名/密码/密钥是否正确");
      }
      throw e;
    }

    try {
      return await callable(conn);
    } finally {
      conn.end();
    }
  }
}
