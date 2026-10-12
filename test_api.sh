#!/bin/bash
B=http://localhost:3000/api
J='-H Content-Type:application/json'
set -e
echo "== register =="
R=$(curl -s -c /tmp/cj.txt $J -d '{"email":"test@example.com","password":"secret123","name":"Тест"}' $B/auth/register); echo "$R" | head -c 200; echo
TOKEN=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
A="$J -b /tmp/cj.txt"; AH="$J -H Authorization:none"
echo "== me =="; curl -s $A $B/auth/me; echo
echo "== roles =="; curl -s $A $B/roles | python3 -m json.tool | head -8
echo "== add contacts =="
C1=$(curl -s $A $J -d '{"first_name":"Иван","last_name":"Петров","telegram":"@ivan"}' $B/contacts)
C2=$(curl -s $A $J -d '{"first_name":"Мария"}' $B/contacts)
ID1=$(echo "$C1" | python3 -c "import sys,json;print(json.load(sys.stdin)['contact']['id'])")
ID2=$(echo "$C2" | python3 -c "import sys,json;print(json.load(sys.stdin)['contact']['id'])")
SELF=$(curl -s $A $B/contacts | python3 -c "import sys,json;print([c['id'] for c in json.load(sys.stdin)['contacts'] if c['self']][0])")
echo "ids: self=$SELF c1=$ID1 c2=$ID2"
echo "== edit contact =="; curl -s $A $J -X PUT -d '{"last_name":"Сидоров"}' $B/contacts/$ID1 | head -c 200; echo
echo "== connection symmetric (Друг) =="
curl -s $A $J -d "{\"contact1_id\":$ID1,\"contact2_id\":$ID2,\"role1_id\":1}" $B/connections; echo
echo "== duplicate rejected =="; curl -s $A $J -d "{\"contact1_id\":$ID1,\"contact2_id\":$ID2,\"role1_id\":1}" $B/connections; echo
echo "== connection asymmetric (Руководитель -> Подчиненный, self->c1) =="
curl -s $A $J -d "{\"contact1_id\":$SELF,\"contact2_id\":$ID1,\"role1_id\":5}" $B/connections; echo
echo "== connections of c1 =="; curl -s $A "$B/connections?contact_id=$ID1" | python3 -m json.tool | grep -E 'role1_name|role2_name|contact._first'; echo
echo "== general note =="; curl -s $A $J -d '{"text":"Наблюдение про всех сразу"}' $B/notes | head -c 250; echo
echo "== private note on c1 =="; curl -s $A $J -d "{\"text\":\"Иван сегодня спорил\",\"contact_id\":$ID1}" $B/notes | head -c 250; echo
echo "== notes feed =="; curl -s $A $B/notes | python3 -c "import sys,json;n=json.load(sys.stdin)['notes'];print(len(n),'notes;',[x['contact_first_name'] for x in n])"
echo "== delete note 404 check =="; NID=$(curl -s $A $B/notes | python3 -c "import sys,json;print(json.load(sys.stdin)['notes'][0]['id'])"); curl -s $A -X DELETE $B/notes/$NID; echo
echo "== cannot delete self =="; curl -s $A -X DELETE $B/contacts/$SELF; echo
echo "== delete c2 + its connections =="; curl -s $A -X DELETE $B/contacts/$ID2; echo
echo "== conn list after delete =="; curl -s $A "$B/connections" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['connections']),'connections left')"
echo "== unauthorized =="; curl -s $B/contacts; echo
echo ALL_TESTS_DONE
