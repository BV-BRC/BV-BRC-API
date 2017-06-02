# Managing Static contents

PATRIC static contents such as user guide and data landing pages are stored in this repo. This page will guides you to configure a local machine setup so that you can preview content while you're editing.



## Requirements

In order to have a local setup, you need to install some developer tools, such as node, git & nginx. If you have those tools, skip this section. 

Here is how to check. 

Open terminal app (Applications > Utilities > Terminal) for MacOS. 

```shell
$ git --version
git version 2.13.0

$ node --version
v6.10.3

$ nginx -v
nginx version: nginx/1.12.0
```

Otherwise, you need to install them. I recommend to use `homebrew` [package manager](https://brew.sh/) to install these tools.

copy and page in terminal,

```
/usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"
```

after installing brew,

```shell
$ brew install git node@6 nginx
```



### Configure local domain

add a line below in  `/var/hosts` file

```
127.0.0.1	www.patric.local
```



### Configure nginx

add a new (e.g  `patric.conf`) file at  `/usr/local/etc/nginx/servers/`

```
server {
        listen 80;
        server_name www.patric.local;
        keepalive_timeout 0;
        client_max_body_size 0;
        underscores_in_headers on;

        location /api/ {
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $remote_addr;
                proxy_set_header Host $host;
                proxy_ignore_client_abort on;
                proxy_buffering off;
                proxy_read_timeout 600s;
                proxy_pass http://127.0.0.1:3001/;
        }
}
```



## Install p3_api

```shell
$ git clone https://github.com/PATRIC3/p3_api.git
$ cd p3_api
$ npm install
```



## Running p3_api

```
# running nginx required once after rebooting
# type admin password when prompted
$ sudo /usr/local/bin/nginx

# running p3_api app. run this in p3_api directory
$ npm start
```

After running p3_api app, open your browser at `http://www.patric.local/api/preview/UserGuide`

After changing corresponding file, refresh your browser, when you should be able to see the updated content with proper css styling.