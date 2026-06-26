/**
 * @main/store 门面：转发到 server/config/store
 *
 * 被复制的 apis / musicbrainz 等模块通过 `@main/store` 引用配置存储，
 * 此文件让该路径别名解析到服务端实现。
 */
export { store } from "./config/store";
