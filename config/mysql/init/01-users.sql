-- 仅在数据目录为空、MySQL 首次初始化时执行。
-- 创建业务账号：nacos（仅 nacos_config）、admin（全局）。root 密码见 compose 环境变量。
CREATE DATABASE IF NOT EXISTS nacos_config
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'nacos'@'%' IDENTIFIED BY 'Admin13278@';
CREATE USER IF NOT EXISTS 'admin'@'%' IDENTIFIED BY 'Admin13278@';

ALTER USER 'nacos'@'%' IDENTIFIED BY 'Admin13278@';
ALTER USER 'admin'@'%' IDENTIFIED BY 'Admin13278@';

GRANT ALL PRIVILEGES ON nacos_config.* TO 'nacos'@'%';
GRANT ALL PRIVILEGES ON *.* TO 'admin'@'%' WITH GRANT OPTION;

FLUSH PRIVILEGES;
