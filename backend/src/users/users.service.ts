import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderDirection, Prisma, Role, UserScope } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  private userListSelect = {
    id: true,
    username: true,
    name: true,
    role: true,
    scopes: true,
    directions: true,
    onShift: true,
    onShiftAt: true,
    createdAt: true,
  } as const;

  /** Роли, участвующие в автораспределении заказов. */
  private static readonly DESIGNER_ROLES: Role[] = [
    Role.SKETCH_DESIGNER,
    Role.REVISION_DESIGNER,
  ];

  private normalizeScopes(scopes?: UserScope[]) {
    if (!scopes) return undefined;
    return Array.from(new Set(scopes));
  }

  private normalizeDirections(directions?: OrderDirection[]) {
    if (!directions) return undefined;
    return Array.from(new Set(directions));
  }

  findAll() {
    return this.prisma.user.findMany({
      select: this.userListSelect,
      orderBy: { id: 'asc' },
    });
  }

  /** Список только художников для экрана управления сменами. */
  findShiftArtists() {
    return this.prisma.user.findMany({
      where: { role: { in: UsersService.DESIGNER_ROLES } },
      select: this.userListSelect,
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
  }

  async create(dto: CreateUserDto) {
    const username = dto.username.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictException('Пользователь с таким логином уже существует');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    return this.prisma.user.create({
      data: {
        username,
        name: dto.name.trim(),
        role: dto.role ?? Role.MANAGER,
        scopes: this.normalizeScopes(dto.scopes) ?? [],
        directions: this.normalizeDirections(dto.directions) ?? [],
        passwordHash,
      },
      select: this.userListSelect,
    });
  }

  async update(id: number, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Пользователь не найден');
    }

    const data: Prisma.UserUpdateInput = {};

    if (dto.username !== undefined) {
      const username = dto.username.trim().toLowerCase();
      if (username !== existing.username) {
        const conflict = await this.prisma.user.findUnique({ where: { username } });
        if (conflict) {
          throw new ConflictException('Пользователь с таким логином уже существует');
        }
      }
      data.username = username;
    }

    if (dto.name !== undefined) {
      data.name = dto.name.trim();
    }

    if (dto.role !== undefined) {
      data.role = dto.role;
    }

    if (dto.scopes !== undefined) {
      data.scopes = this.normalizeScopes(dto.scopes) ?? [];
    }

    if (dto.directions !== undefined) {
      data.directions = this.normalizeDirections(dto.directions) ?? [];
    }

    // Роль сменили на не-художника — круги автораспределения его больше
    // не касаются, поэтому смену и направления снимаем.
    const nextRole = dto.role ?? existing.role;
    if (!UsersService.DESIGNER_ROLES.includes(nextRole)) {
      data.directions = [];
      if (existing.onShift) {
        data.onShift = false;
        data.onShiftAt = new Date();
      }
    }

    if (dto.password) {
      data.passwordHash = await bcrypt.hash(dto.password, 10);
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: this.userListSelect,
    });
  }

  /**
   * Переключает статус «На смене». Художник вызывает для себя, администратор —
   * для любого художника (например, если сотрудник пропал со связи).
   */
  async setShift(id: number, onShift: boolean) {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      select: { role: true, onShift: true },
    });
    if (!existing) {
      throw new NotFoundException('Пользователь не найден');
    }
    if (!UsersService.DESIGNER_ROLES.includes(existing.role)) {
      throw new BadRequestException(
        'Статус «На смене» доступен только художникам эскиза и правок',
      );
    }
    if (existing.onShift === onShift) {
      return this.prisma.user.findUniqueOrThrow({
        where: { id },
        select: this.userListSelect,
      });
    }

    return this.prisma.user.update({
      where: { id },
      data: { onShift, onShiftAt: new Date() },
      select: this.userListSelect,
    });
  }
}
