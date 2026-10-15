import { resolve } from 'path';

// Public attachment URLs stay /uploads/... regardless of the physical storage root.
export const uploadRoot = resolve(process.env.UPLOAD_ROOT || resolve(process.cwd(), 'uploads'));
