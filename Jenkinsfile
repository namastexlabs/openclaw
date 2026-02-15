// Jenkinsfile — OpenClaw Fleet Deploy Pipeline
// Triggers on namastex/main commits, builds, deploys fleet, health checks, auto-rollback
pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    triggers {
        // Poll SCM every 5 minutes (switch to webhook later for instant triggers)
        pollSCM('H/5 * * * *')
    }

    environment {
        REPO_DIR     = '/opt/genie/openclaw'
        // Use workspace path (Jenkins checkout), not build-host absolute path
        INSTALL_SCRIPT = 'scripts/install.sh'
        BRANCH       = 'namastex/main'

        // SECURITY: do not hardcode internal SSH targets/IPs in this repo.
        // Configure these via Jenkins credentials (Secret text) instead.
        //
        // Expected credentials:
        // - OPENCLAW_BUILD_HOST (secret text) -> e.g. "genie@<build-host>"
        // - OPENCLAW_FLEET_HOSTS_JSON (secret text) -> JSON array:
        //   [{"ssh":"user@host","label":"cegonha"}, ...]
        BUILD_HOST = credentials('OPENCLAW_BUILD_HOST')
        FLEET_HOSTS_JSON = credentials('OPENCLAW_FLEET_HOSTS_JSON')
    }

    stages {
        stage('Fetch & Detect Changes') {
            steps {
                script {
                    def result = sh(
                        script: """
                            ssh -o BatchMode=yes -o ConnectTimeout=10 ${BUILD_HOST} '
                                cd ${REPO_DIR}
                                BEFORE=\$(git rev-parse HEAD)
                                git fetch origin ${BRANCH} --quiet
                                AFTER=\$(git rev-parse origin/${BRANCH})
                                echo "BEFORE=\$BEFORE"
                                echo "AFTER=\$AFTER"
                                if [ "\$BEFORE" = "\$AFTER" ]; then
                                    echo "NO_CHANGES=true"
                                else
                                    echo "NO_CHANGES=false"
                                    echo "NEW_COMMITS=\$(git log --oneline \$BEFORE..\$AFTER | wc -l)"
                                    git log --oneline \$BEFORE..\$AFTER | head -10
                                fi
                            '
                        """,
                        returnStdout: true
                    ).trim()

                    echo result

                    if (result.contains('NO_CHANGES=true') && !params.FORCE_DEPLOY) {
                        currentBuild.result = 'NOT_BUILT'
                        currentBuild.description = 'No changes detected'
                        echo 'No changes on namastex/main — skipping build'
                        // We still let it proceed so pollSCM keeps working,
                        // but mark downstream stages to skip
                        env.SKIP_DEPLOY = 'true'
                    } else {
                        env.SKIP_DEPLOY = 'false'
                    }
                }
            }
        }

        stage('Build on genie-os') {
            when { expression { env.SKIP_DEPLOY != 'true' } }
            steps {
                sh """
                    ssh -o BatchMode=yes -o ConnectTimeout=10 ${BUILD_HOST} '
                        cd ${REPO_DIR}
                        git pull --ff-only origin ${BRANCH}

                        export NVM_DIR="\$HOME/.nvm"
                        [ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
                        export PATH="\$HOME/.bun/bin:\$PATH"

                        echo "=== bun install ==="
                        bun install --frozen-lockfile 2>/dev/null || bun install

                        echo "=== bun build ==="
                        bun run build

                        echo "=== Smoke test ==="
                        [ -f dist/index.js ] || { echo "FATAL: dist/index.js missing"; exit 1; }

                        echo "BUILD_OK hash=\$(git rev-parse --short HEAD)"
                    '
                """
            }
        }

        stage('Restart Local Gateway') {
            when { expression { env.SKIP_DEPLOY != 'true' } }
            steps {
                sh """
                    ssh -o BatchMode=yes -o ConnectTimeout=10 ${BUILD_HOST} '
                        systemctl --user restart openclaw-gateway

                        # Poll for up to 30s instead of fixed sleep (reduces flakiness)
                        ok=0
                        for i in $(seq 1 15); do
                          if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then ok=1; break; fi
                          sleep 2
                        done

                        if [ "$ok" = "1" ]; then
                            echo "LOCAL_GATEWAY_OK"
                        else
                            echo "LOCAL_GATEWAY_FAILED"
                            systemctl --user status openclaw-gateway || true
                            exit 1
                        fi
                    '
                """
            }
        }

        stage('Deploy Fleet') {
            when { expression { env.SKIP_DEPLOY != 'true' } }
            steps {
                script {
                    def hosts
                    try {
                        hosts = new groovy.json.JsonSlurperClassic().parseText(env.FLEET_HOSTS_JSON)
                    } catch (Exception e) {
                        error("Invalid OPENCLAW_FLEET_HOSTS_JSON: ${e.message}")
                    }
                    if (!(hosts instanceof List) || hosts.size() == 0) {
                        error('OPENCLAW_FLEET_HOSTS_JSON must be a non-empty JSON array of {ssh,label} objects')
                    }

                    def branches = [:]

                    for (h in hosts) {
                        def sshTarget = h.ssh
                        def label = h.label
                        branches[label] = {
                            stage("${label}") {
                                deployHost(sshTarget, label)
                            }
                        }
                    }

                    parallel branches
                }
            }
        }

        stage('Health Checks') {
            when { expression { env.SKIP_DEPLOY != 'true' } }
            steps {
                script {
                    def hosts
                    try {
                        hosts = new groovy.json.JsonSlurperClassic().parseText(env.FLEET_HOSTS_JSON)
                    } catch (Exception e) {
                        error("Invalid OPENCLAW_FLEET_HOSTS_JSON: ${e.message}")
                    }
                    if (!(hosts instanceof List) || hosts.size() == 0) {
                        error('OPENCLAW_FLEET_HOSTS_JSON must be a non-empty JSON array of {ssh,label} objects')
                    }

                    def failed = []

                    for (h in hosts) {
                        // Poll each host for up to ~60s after deploy (slow CTs)
                        def rc = sh(
                            script: """
                                for i in \$(seq 1 20); do
                                  ssh -o BatchMode=yes -o ConnectTimeout=10 ${h.ssh} '\
                                    systemctl --user is-active openclaw-gateway >/dev/null 2>&1 || exit 1;\
                                    ss -tlnp 2>/dev/null | grep -q ":18789" || exit 1;\
                                  ' && exit 0
                                  sleep 3
                                done
                                echo "HEALTH_FAIL: ${h.label}"
                                exit 1
                            """,
                            returnStatus: true
                        )
                        if (rc != 0) {
                            echo "HEALTH FAILED: ${h.label}"
                            failed.add(h.label)
                        } else {
                            echo "HEALTH_OK: ${h.label}"
                        }
                    }

                    if (failed.size() > 0) {
                        currentBuild.description = "Health check failed: ${failed.join(', ')}"
                        error("Health checks failed on: ${failed.join(', ')}")
                    } else {
                        currentBuild.description = "Deployed to all fleet hosts ✅"
                    }
                }
            }
        }
    }

    post {
        failure {
            echo 'Pipeline failed — check logs for rollback needs'
            // Future: auto-rollback via fleet-update.sh --rollback
        }
        success {
            echo 'Fleet deploy complete ✅'
        }
        always {
            echo "Build finished: ${currentBuild.currentResult}"
        }
    }

    parameters {
        booleanParam(name: 'FORCE_DEPLOY', defaultValue: false, description: 'Deploy even if no new commits detected')
    }
}

// Deploy to a single fleet host via install.sh piped over SSH
def deployHost(String sshTarget, String hostLabel) {
    sh """
        echo "Deploying to ${hostLabel} (${sshTarget})..."
        ssh -o BatchMode=yes -o ConnectTimeout=10 ${sshTarget} \
            'bash -s -- --restart' < ${INSTALL_SCRIPT}
        echo "DEPLOY_OK: ${hostLabel}"
    """
}
