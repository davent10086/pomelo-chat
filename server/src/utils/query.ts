import db from '../model/db';

// 封装统一的 sql 语句执行函数
export const Query = (sql: string, info?: any): Promise<any> => {
	return new Promise((resolve, reject) => {
		db.query(sql, info, (err, results) => {
			if (err) return reject(err);
			resolve(results);
		});
	});
};
