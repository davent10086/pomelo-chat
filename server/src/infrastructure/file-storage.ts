import { resolve } from 'path';

// Public attachment URLs stay /uploads/... regardless of the physical storage root.
// src/infrastructure and dist/infrastructure both resolve to the server directory.
export const uploadRoot = resolve(__dirname, '../..', process.env.UPLOAD_ROOT || 'uploads');
