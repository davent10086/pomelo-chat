/** This product's wall-clock fields and calendar search use China Standard Time. */
export const APPLICATION_TIME_ZONE = 'Asia/Shanghai';
export const DATABASE_TIME_ZONE = '+08:00';
// Keep legacy DATETIME values and Prisma's wall-clock compatibility codec stable on UTC hosts.
process.env.TZ = APPLICATION_TIME_ZONE;
export const formatTimestamp = (value: Date | string | number): string => new Date(value).toLocaleString('zh-CN', { timeZone: APPLICATION_TIME_ZONE, hour12: false });
