const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const users = [
    { username: 'admin', name: 'Администратор', role: 'ADMIN', password: 'inub398dhsj9-mkj' },
  ];

  for (const u of users) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    await prisma.user.upsert({
      where: { username: u.username },
      update: { name: u.name, role: u.role, passwordHash },
      create: { username: u.username, name: u.name, role: u.role, passwordHash },
    });
    console.log(`Seeded user: ${u.username} / ${u.password}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
