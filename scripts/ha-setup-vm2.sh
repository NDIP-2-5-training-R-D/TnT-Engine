#!/bin/bash
# ================================================================
# Script setup VM2 (10.10.55.12) làm Worker Node + HA storage
# Chạy trên VM2
# ================================================================
VM1_IP="10.10.55.11"
RKE2_TOKEN="<PASTE_TOKEN_FROM_VM1>"
# Lấy token từ VM1: sudo cat /var/lib/rancher/rke2/server/node-token

echo "======================================"
echo "Bước 1: Mở firewall ports cho K8s/Cilium"
echo "======================================"
sudo ufw allow 8472/udp comment "Cilium VXLAN"
sudo ufw allow 4789/udp comment "Cilium VXLAN alt"
sudo ufw allow 10250/tcp comment "Kubelet API"
sudo ufw allow from 10.42.0.0/16 comment "K8s pod CIDR"
sudo ufw allow from ${VM1_IP} comment "VM1 node"
sudo ufw reload

echo ""
echo "======================================"
echo "Bước 2: Cài RKE2 agent (worker node)"
echo "======================================"
curl -sfL https://get.rke2.io | sudo INSTALL_RKE2_TYPE="agent" sh -

sudo mkdir -p /etc/rancher/rke2
sudo tee /etc/rancher/rke2/config.yaml <<EOF
server: https://${VM1_IP}:9345
token: ${RKE2_TOKEN}
EOF

sudo systemctl enable rke2-agent --now
echo "Chờ VM2 join cluster..."
sleep 30
