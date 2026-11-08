FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs index.html app.js app.css shared.mjs icon.svg ./
COPY lib ./lib
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8732 DATA_DIR=/app/data
EXPOSE 8732
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8732/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","server.mjs"]
