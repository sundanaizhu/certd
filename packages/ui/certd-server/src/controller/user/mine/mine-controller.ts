import { ALL, Body, Controller, Inject, Post, Provide } from '@midwayjs/core';
import { BaseController, Constants } from '@certd/lib-server';
import { UserService } from '../../../modules/sys/authority/service/user-service.js';
import { RoleService } from '../../../modules/sys/authority/service/role-service.js';

/**
 */
@Provide()
@Controller('/api/mine')
export class MineController extends BaseController {
  @Inject()
  userService: UserService;
  @Inject()
  roleService: RoleService;
  @Post('/info', { summary: Constants.per.authOnly })
  public async info() {
    const userId = this.getUserId();
    const user = await this.userService.info(userId);
    const isWeak = await this.userService.checkPassword('123456', user.password, user.passwordVersion);
    if (isWeak) {
      //@ts-ignore
      user.isWeak = true;
    }
    user.roleIds = await this.roleService.getRoleIdsByUserId(userId);
    delete user.password;
    return this.ok(user);
  }

  @Post('/changePassword', { summary: Constants.per.authOnly })
  public async changePassword(@Body(ALL) body: any) {
    const userId = this.getUserId();
    await this.userService.changePassword(userId, body);
    return this.ok({});
  }
}
