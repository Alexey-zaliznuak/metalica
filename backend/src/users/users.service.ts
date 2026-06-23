import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, UserScope } from '@prisma/client';
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
    createdAt: true,
  } as const;

  private normalizeScopes(scopes?: UserScope[]) {
    if (!scopes) return undefined;
    return Array.from(new Set(scopes));
  }

  findAll() {
    return this.prisma.user.findMany({
      select: this.userListSelect,
      orderBy: { id: 'asc' },
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

    if (dto.password) {
      data.passwordHash = await bcrypt.hash(dto.password, 10);
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: this.userListSelect,
    });
  }
}
