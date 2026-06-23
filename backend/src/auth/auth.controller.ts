import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, AuthUser } from './current-user.decorator';
import { UpdateFrontendSettingsDto } from './dto/update-frontend-settings.dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Patch('frontend-settings')
  updateFrontendSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateFrontendSettingsDto,
  ) {
    return this.auth.updateFrontendSettings(user.id, dto.frontendSettings);
  }
}
