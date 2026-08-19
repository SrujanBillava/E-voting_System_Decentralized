git add .
git commit

echo ""
echo "Press 'y' to push to origin main."
echo "Press any other key to exit."

read -n 1 -s push_choice
echo ""

if [[ $push_choice == "y" || $push_choice == "Y" ]]; then
    git push origin main
else
  echo "❌ Exiting without git push."
fi