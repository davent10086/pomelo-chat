import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { databaseUrl } from './src/infrastructure/database-config';

export default defineConfig({
	schema: 'prisma/schema.prisma',
	datasource: { url: databaseUrl }
});
