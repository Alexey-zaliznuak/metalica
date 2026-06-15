import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      select: { id: true, username: true, name: true, role: true, createdAt: true },
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
        passwordHash,
      },
      select: { id: true, username: true, name: true, role: true, createdAt: true },
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

    if (dto.password) {
      data.passwordHash = await bcrypt.hash(dto.password, 10);
    }

    return this.prisma.user.update({
      where: { id },
      data,
      select: { id: true, username: true, name: true, role: true, createdAt: true },
    });
  }
}
