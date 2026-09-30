请帮我在这台服务器上部署一个静态官网。服务器是 Ubuntu，域名是 lingxi-engine.com
（DNS 已解析到本机公网 IP）。请你自己检查系统版本、权限和端口占用情况，
然后用 root 权限完成全部工作，并把每一步结果都告诉我。

背景：这台机器目前 80 和 443 端口是空闲的，nginx 未安装，没有其他网站。
站点文件我已经打包好放在公网地址：
https://h.uguu.se/prrzMGrS.tar.gz
（33,887 字节的 tar.gz，包内是 index.html / privacy.html / terms.html /
robots.txt / js/official-i18n.js）

请按下面顺序执行：

1. 检查 id -u 是否为 0，检查 ss -tlnp 看 80/443 是否被占用，
   并检查 nginx 是否已安装。把检查结果告诉我。
2. mkdir -p /opt/lingxi-site /var/www/html/.well-known/acme-challenge
   下载站点包：curl -fSL --max-time 60 -o /tmp/site.tar.gz
   https://h.uguu.se/prrzMGrS.tar.gz
   然后 tar -xzf /tmp/site.tar.gz -C /opt/lingxi-site
   用 ls -la /opt/lingxi-site 确认 5 个文件都在。
3. 写入 /etc/nginx/conf.d/lingxi-site.conf，内容如下（先只启用 80 端口，
   因为证书还没签发，所以这一版不要包含 ssl 相关配置）：
   server {
       listen 80;
       listen [::]:80;
       server_name lingxi-engine.com www.lingxi-engine.com;
       location ^~ /.well-known/acme-challenge/ {
           root /var/www/html;
           default_type "text/plain";
           allow all;
       }
       location / {
           root /opt/lingxi-site;
           index index.html;
           try_files $uri $uri/ /index.html;
       }
       location ~* \.(css|js|svg|png|jpg|webp|woff2?)$ {
           root /opt/lingxi-site;
           expires 7d;
           add_header Cache-Control "public, max-age=604800";
       }
       access_log /var/log/nginx/lingxi-access.log;
       error_log /var/log/nginx/lingxi-error.log;
   }
4. 安装并启动 nginx：
   export DEBIAN_FRONTEND=noninteractive
   apt-get update -qq && apt-get install -y -qq nginx curl certbot python3-certbot-nginx
   systemctl enable --now nginx
5. nginx -t 检查语法，通过后 systemctl reload nginx。
   然后从本机自检：curl -s -o /dev/null -w "HTTP %{http_code}\n"
   -H "Host: lingxi-engine.com" http://127.0.0.1/
   要看到 200。terms.html 和 privacy.html 也要 200。
7. 申请 Let's Encrypt 证书：
   certbot certonly --webroot -w /var/www/html -d lingxi-engine.com -d www.lingxi-engine.com
   --non-interactive --agree-tos --register-unsafely-without-email
8. 证书拿到后，把 /etc/nginx/conf.d/lingxi-site.conf 覆盖为 80 端口强制
   301 跳转 + 443 端口的 HTTPS 版本（证书路径
   /etc/letsencrypt/live/lingxi-engine.com/fullchain.pem 和 privkey.pem，
   加 Strict-Transport-Security 头，http2 on），然后 nginx -t 再 reload。
9. 确认安全组已经放行 80 和 443 端口（用 ss -tlnp 确认进程在监听，
   再用 curl 访问公网 IP 试试）。
10. 最后把整个过程完整报告给我，包含每一步的成功或失败标记。

重要提醒：
- 不要覆盖或删除服务器上任何已有的服务或配置，只新增。
- 如果 80/443 已经被别的服务占用，停下来告诉我，不要强行覆盖。
- 每一步失败都不要继续往下走，停下来说明原因。
- 不要把任何密码或私钥输出到对话里。
- 全部完成后告诉我，请把公网访问地址和自检结果一起给我。
