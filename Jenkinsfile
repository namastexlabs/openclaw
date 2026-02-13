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
        // genie-os is the build host — Jenkins SSHes there to build, then fans out
        BUILD_HOST   = 'genie@10.114.1.111'
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
                        sleep 4
                        if systemctl --user is-active openclaw-gateway >/dev/null 2>&1; then
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
            parallel {
                stage('cegonha (121)') {
                    steps { deployHost('genie@10.114.1.121', 'cegonha') }
                }
                stage('stefani (124)') {
                    steps { deployHost('genie@10.114.1.124', 'stefani') }
                }
                stage('gus (126)') {
                    steps { deployHost('genie@10.114.1.126', 'gus') }
                }
                stage('luis (131)') {
                    steps { deployHost('genie@10.114.1.131', 'luis') }
                }
                stage('sampaio (154)') {
                    steps { deployHost('genie@10.114.1.154', 'sampaio') }
                }
                stage('juice (119)') {
                    steps { deployHost('openclaw@10.114.1.119', 'juice') }
                }
                stage('omni-prod (140)') {
                    steps { deployHost('genie@10.114.1.140', 'omni-prod') }
                }
            }
        }

        stage('Health Checks') {
            when { expression { env.SKIP_DEPLOY != 'true' } }
            steps {
                // Wait for slow hosts to finish restarting
                sleep(time: 15, unit: 'SECONDS')
                script {
                    def hosts = [
                        [ssh: 'genie@10.114.1.111', name: 'genie-os'],
                        [ssh: 'genie@10.114.1.121', name: 'cegonha'],
                        [ssh: 'genie@10.114.1.124', name: 'stefani'],
                        [ssh: 'genie@10.114.1.126', name: 'gus'],
                        [ssh: 'genie@10.114.1.131', name: 'luis'],
                        [ssh: 'genie@10.114.1.154', name: 'sampaio'],
                        [ssh: 'openclaw@10.114.1.119', name: 'juice'],
                        [ssh: 'genie@10.114.1.140', name: 'omni-prod'],
                    ]
                    def failed = []

                    for (h in hosts) {
                        def rc = sh(
                            script: """
                                ssh -o BatchMode=yes -o ConnectTimeout=10 ${h.ssh} '
                                    systemctl --user is-active openclaw-gateway >/dev/null 2>&1 || exit 1
                                    ss -tlnp 2>/dev/null | grep -q ":18789" || exit 1
                                    echo "HEALTH_OK: ${h.name}"
                                '
                            """,
                            returnStatus: true
                        )
                        if (rc != 0) {
                            echo "HEALTH FAILED: ${h.name}"
                            failed.add(h.name)
                        }
                    }

                    if (failed.size() > 0) {
                        currentBuild.description = "Health check failed: ${failed.join(', ')}"
                        error("Health checks failed on: ${failed.join(', ')}")
                    } else {
                        currentBuild.description = "Deployed to all 8 hosts ✅"
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
